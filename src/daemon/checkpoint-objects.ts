import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createDeflate, createInflate, deflate, inflate } from "node:zlib";

/**
 * The part of a bare git repository that checkpoints need: loose objects,
 * trees, commits and one branch. `git` can read the result, but nothing here
 * needs it. Every file is written under a temporary name and then renamed, so
 * a process that is stopped half way leaves no damaged object. A machine that
 * loses power still can, so objects are checked against their id when read.
 */

export interface TreeEntry {
  /** `40000` for a folder, `100644` or `100755` for a file, `120000` for a symbolic link. */
  mode: string;
  name: string;
  oid: string;
}

/** A file to store could not be read. `code` is the file system's error code. */
export class SourceError extends Error {
  constructor(
    readonly code: string | undefined,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** A file to store did not hold still while it was read. */
export class FileChangedError extends Error {}

/** A stored object is not what its id stands for. */
export class DamagedObjectError extends Error {
  constructor(readonly oid: string) {
    super(`Checkpoint object ${oid} is damaged`);
  }
}

/** What a commit records of a workspace. */
export interface Commit {
  tree: string;
  /** The paths that were there and could not be read, in path order. The tree holds nothing at them or below them. */
  unreadable: string[];
}

export const TREE_MODE = "40000";
const HEAD_REF = "refs/heads/checkpoints";
const MESSAGE = "checkpoint\n";
const UNREADABLE_LINE = /^checkpoint\n\nunreadable: ([^\n]*)\n$/;
/** Larger files are streamed instead of being held in memory, and are read twice: once for their id and once to store them. */
export const BUFFERED_BYTES = 4 * 1024 * 1024;
// Deflate shrinks content about a thousand times at most, so an object this small is safe to inflate in memory.
const BUFFERED_OBJECT_BYTES = 64 * 1024;
// The level git itself uses for loose objects: assets hardly compress, so speed matters more.
const COMPRESSION = { level: 1 };

const deflateBuffer = promisify(deflate);
const inflateBuffer = promisify(inflate);

/** Marks a failure as one of reading the files to store, so that it is not taken for a failure of the store. */
export async function fromSource<T>(operation: Promise<T>): Promise<T> {
  return await operation.catch((error: NodeJS.ErrnoException) => {
    throw new SourceError(error.code, error);
  });
}

export async function initialize(gitdir: string): Promise<void> {
  if (await exists(path.join(gitdir, "HEAD"))) return;
  // The folder the store is in is not made along with it: where that folder is gone, the project was removed.
  await mkdir(gitdir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await mkdir(path.join(gitdir, "objects"), { recursive: true });
  await mkdir(path.join(gitdir, "refs", "heads"), { recursive: true });
  await writeAtomically(
    gitdir,
    path.join(gitdir, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n",
  );
  await writeAtomically(
    gitdir,
    path.join(gitdir, "HEAD"),
    `ref: ${HEAD_REF}\n`,
  );
}

/** The newest commit, or undefined when there is none yet. */
export async function readHead(gitdir: string): Promise<string | undefined> {
  const oid = await readFile(path.join(gitdir, HEAD_REF), "utf8").then(
    (text) => text.trim(),
    () => undefined,
  );
  return oid && isOid(oid) ? oid : undefined;
}

export async function writeHead(gitdir: string, commit: string): Promise<void> {
  await writeAtomically(gitdir, path.join(gitdir, HEAD_REF), `${commit}\n`);
}

export async function writeObject(
  gitdir: string,
  type: "blob" | "tree" | "commit",
  content: Buffer,
): Promise<string> {
  const header = Buffer.from(`${type} ${content.length}\0`);
  const oid = createHash("sha1").update(header).update(content).digest("hex");
  const target = objectPath(gitdir, oid);
  if (!(await stored(target))) {
    const deflated = await deflateBuffer(
      Buffer.concat([header, content]),
      COMPRESSION,
    );
    await storeObject(target, (temporary) =>
      writeFile(temporary, deflated, { flag: "wx" }),
    );
  }
  return oid;
}

/** Stores a file's content as a blob. Content the store already holds is not compressed and written again. */
export async function writeFileBlob(
  gitdir: string,
  file: string,
  size: number,
): Promise<string> {
  if (size <= BUFFERED_BYTES)
    return await writeObject(gitdir, "blob", await fromSource(readFile(file)));
  const oid = await fileBlobId(file, size);
  const target = objectPath(gitdir, oid);
  if (await stored(target)) return oid;
  await storeObject(target, async (temporary) => {
    const written = createHash("sha1");
    await pipeline(
      fileBlob(file, size, written),
      createDeflate(COMPRESSION),
      createWriteStream(temporary, { flags: "wx" }),
    );
    if (written.digest("hex") !== oid)
      throw new FileChangedError(`${file} changed while it was read`);
  });
  return oid;
}

/** The id a file's content has as a blob, without storing it. */
export async function fileBlobId(file: string, size: number): Promise<string> {
  if (size <= BUFFERED_BYTES) return blobId(await fromSource(readFile(file)));
  const hash = createHash("sha1");
  for await (const _ of fileBlob(file, size, hash)) {
    /* Reading it through is what finds the id. */
  }
  return hash.digest("hex");
}

export function blobId(content: Buffer): string {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

/** A large file as a blob with its header. Exactly `size` bytes are read, so a file that grows meanwhile still gives an object that matches its header. */
async function* fileBlob(
  file: string,
  size: number,
  hash: Hash,
): AsyncGenerator<Buffer> {
  const header = Buffer.from(`blob ${size}\0`);
  hash.update(header);
  yield header;
  let read = 0;
  const stream = createReadStream(file, { end: size - 1 });
  try {
    const chunks = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    for (
      let next = await fromSource(chunks.next());
      !next.done;
      next = await fromSource(chunks.next())
    ) {
      hash.update(next.value);
      read += next.value.length;
      yield next.value;
    }
  } finally {
    stream.destroy();
  }
  if (read !== size)
    throw new FileChangedError(`${file} changed while it was read`);
}

/** Stores a file that does not hold still, from a copy that does. */
export async function writeFileCopyBlob(
  gitdir: string,
  file: string,
): Promise<string> {
  const copy = temporaryPath(gitdir);
  try {
    await fromSource(copyFile(file, copy));
    return await writeFileBlob(gitdir, copy, (await lstat(copy)).size);
  } finally {
    await rm(copy, { force: true });
  }
}

export async function readObject(
  gitdir: string,
  oid: string,
  type: "blob" | "tree" | "commit",
): Promise<Buffer> {
  const stored = await readFile(objectPath(gitdir, oid)).catch(
    (error: NodeJS.ErrnoException) => {
      throw error.code === "ENOENT"
        ? new Error(`Checkpoint object ${oid} does not exist`)
        : error;
    },
  );
  const object = await inflateBuffer(stored).catch(() => {
    throw new DamagedObjectError(oid);
  });
  const end = object.indexOf(0);
  if (createHash("sha1").update(object).digest("hex") !== oid)
    throw new DamagedObjectError(oid);
  if (
    object.toString("latin1", 0, end) !== `${type} ${object.length - end - 1}`
  )
    throw new Error(`Checkpoint object ${oid} is not a ${type}`);
  return object.subarray(end + 1);
}

/**
 * Reads at most `limit` bytes of a blob's content, inflating no more of it
 * than that. A blob that fits is checked against its id as `readObject` does;
 * of a longer one only the start is read, so only damage that the inflating
 * meets there is found.
 */
export async function readBlobStart(
  gitdir: string,
  oid: string,
  limit: number,
): Promise<Buffer> {
  const hash = createHash("sha1");
  const kept: Buffer[] = [];
  let size = 0;
  let length: number | undefined;
  let header = Buffer.alloc(0);
  const source = createReadStream(objectPath(gitdir, oid));
  const inflating = source.pipe(createInflate());
  source.once("error", (error) => inflating.destroy(error));
  try {
    for await (const chunk of inflating as AsyncIterable<Buffer>) {
      hash.update(chunk);
      let content = chunk;
      if (length === undefined) {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf(0);
        if (end === -1) {
          if (header.length > 64) throw new DamagedObjectError(oid);
          continue;
        }
        const [type, count = ""] = header.toString("latin1", 0, end).split(" ");
        if (type !== "blob" || !/^\d+$/.test(count))
          throw new Error(`Checkpoint object ${oid} is not a blob`);
        length = Number(count);
        content = header.subarray(end + 1);
      }
      const part = content.subarray(0, Math.max(limit - size, 0));
      kept.push(part);
      size += part.length;
      // Leaving the loop stops the reading and the inflating.
      if (length > limit && size >= limit) return Buffer.concat(kept);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new Error(`Checkpoint object ${oid} does not exist`);
    throw String(code).startsWith("Z_") ? new DamagedObjectError(oid) : error;
  } finally {
    source.destroy();
  }
  if (size !== length || hash.digest("hex") !== oid)
    throw new DamagedObjectError(oid);
  return Buffer.concat(kept);
}

/** Writes a blob's content into a new file, which is created with the given permissions. */
export async function writeBlobTo(
  gitdir: string,
  oid: string,
  target: string,
  mode?: number,
): Promise<void> {
  const size = await lstat(objectPath(gitdir, oid)).then(
    (stats) => stats.size,
    () => 0,
  );
  if (size <= BUFFERED_OBJECT_BYTES) {
    await writeFile(target, await readObject(gitdir, oid, "blob"), {
      flag: "wx",
      mode,
    });
    return;
  }
  try {
    await streamBlob(
      gitdir,
      oid,
      createWriteStream(target, { flags: "wx", mode }),
    );
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}

/** Reads a blob through and throws `DamagedObjectError` when it is missing or not whole. */
export async function verifyBlob(gitdir: string, oid: string): Promise<void> {
  await streamBlob(gitdir, oid).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ENOENT" ? new DamagedObjectError(oid) : error;
  });
}

/** Removes an object that turned out to be damaged, so that it is written anew when its content is stored again. */
export async function removeObject(gitdir: string, oid: string): Promise<void> {
  await rm(objectPath(gitdir, oid), { force: true });
}

/** Streams a blob's content, to a file when one is given, and checks it against its id. */
async function streamBlob(
  gitdir: string,
  oid: string,
  destination?: NodeJS.WritableStream,
): Promise<void> {
  const hash = createHash("sha1");
  async function* content(
    chunks: AsyncIterable<Buffer>,
  ): AsyncGenerator<Buffer> {
    let header = true;
    for await (const chunk of chunks) {
      hash.update(chunk);
      const end = header ? chunk.indexOf(0) : -1;
      if (!header) yield chunk;
      else if (end !== -1) {
        header = false;
        yield chunk.subarray(end + 1);
      }
    }
  }
  const source = createReadStream(objectPath(gitdir, oid));
  try {
    if (destination)
      await pipeline(source, createInflate(), content, destination);
    else
      await pipeline(
        source,
        createInflate(),
        content,
        async (chunks: AsyncIterable<Buffer>) => {
          for await (const _ of chunks) {
            /* Reading it is the check. */
          }
        },
      );
  } catch (error) {
    // Only the inflating can tell that the object is damaged; other failures, such as a full disk, are what they are.
    throw String((error as NodeJS.ErrnoException).code).startsWith("Z_")
      ? new DamagedObjectError(oid)
      : error;
  }
  if (hash.digest("hex") !== oid) throw new DamagedObjectError(oid);
}

export async function writeTree(
  gitdir: string,
  entries: TreeEntry[],
): Promise<string> {
  // Git orders a tree by name, with a folder compared as if its name ended in a slash.
  const sorted = entries
    .map((entry) => ({
      entry,
      key: Buffer.from(
        entry.mode === TREE_MODE ? `${entry.name}/` : entry.name,
      ),
    }))
    .sort((left, right) => Buffer.compare(left.key, right.key));
  return await writeObject(
    gitdir,
    "tree",
    Buffer.concat(
      sorted.flatMap(({ entry }) => [
        Buffer.from(`${entry.mode} ${entry.name}\0`),
        Buffer.from(entry.oid, "hex"),
      ]),
    ),
  );
}

export async function readTree(
  gitdir: string,
  oid: string,
): Promise<TreeEntry[]> {
  const content = await readObject(gitdir, oid, "tree");
  const entries: TreeEntry[] = [];
  for (let cursor = 0; cursor < content.length;) {
    const space = content.indexOf(0x20, cursor);
    const end = content.indexOf(0, space);
    entries.push({
      mode: content.toString("latin1", cursor, space),
      name: content.toString("utf8", space + 1, end),
      oid: content.toString("hex", end + 1, end + 21),
    });
    cursor = end + 21;
  }
  return entries;
}

/** Writes a commit. The paths that could not be read go into its message. */
export async function writeCommit(
  gitdir: string,
  tree: string,
  parent: string | undefined,
  unreadable: string[],
): Promise<string> {
  const signature = `OhMyGame <checkpoints@ohmygame.local> ${Math.floor(Date.now() / 1000)} +0000`;
  const text = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${signature}\ncommitter ${signature}\n\n${messageFor(unreadable)}`;
  return await writeObject(gitdir, "commit", Buffer.from(text));
}

/** The message of a commit. The paths are in it as JSON, so that a name with a line break stays on one line. */
function messageFor(unreadable: string[]): string {
  return unreadable.length
    ? `${MESSAGE}\nunreadable: ${JSON.stringify(unreadable)}\n`
    : MESSAGE;
}

export async function readCommitTree(
  gitdir: string,
  commit: string,
): Promise<string> {
  return (await readObject(gitdir, commit, "commit")).toString("latin1", 5, 45);
}

/** Reads a commit's tree and the paths that could not be read when it was written. */
export async function readCommit(
  gitdir: string,
  commit: string,
): Promise<Commit> {
  const text = (await readObject(gitdir, commit, "commit")).toString("utf8");
  const message = text.slice(text.indexOf("\n\n") + 2);
  const unreadable =
    message === MESSAGE
      ? []
      : pathList(UNREADABLE_LINE.exec(message)?.[1] ?? "");
  // A message that cannot be made out must not read as one without a list: every path would then count as one that was
  // read. Nor is a list taken that is not written as `writeCommit` writes it, where a path could stand for no file at all.
  if (!unreadable || messageFor(unreadable) !== message)
    throw new Error(`Checkpoint ${commit} does not say what could not be read`);
  return { tree: text.slice(5, 45), unreadable };
}

/** The workspace paths that a text lists as JSON, or undefined when it is anything but such paths in path order. */
function pathList(json: string): string[] | undefined {
  try {
    const paths: unknown = JSON.parse(json);
    const follows = (
      entry: unknown,
      index: number,
      entries: unknown[],
    ): boolean =>
      typeof entry === "string" &&
      (index === 0 || (entries[index - 1] as string) < entry) &&
      entry
        .split("/")
        .every((name) => name !== "" && name !== "." && name !== "..");
    return Array.isArray(paths) && paths.every(follows)
      ? (paths as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

/** Writes a small file of the store, such as its branch, so that it is either the old or the new one. */
export async function writeAtomically(
  gitdir: string,
  target: string,
  content: string,
): Promise<void> {
  const temporary = temporaryPath(gitdir);
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function storeObject(
  target: string,
  write: (temporary: string) => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  // The name git gives its own unfinished objects, which it knows to ignore.
  const temporary = path.join(path.dirname(target), `tmp_obj_${randomUUID()}`);
  try {
    await write(temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    // The same content stored at the same moment by another operation is as good.
    if (error instanceof FileChangedError || !(await stored(target)))
      throw error;
  }
}

function objectPath(gitdir: string, oid: string): string {
  // Ids come from callers, and they become part of a path.
  if (!isOid(oid)) throw new Error("Not a checkpoint id");
  return path.join(gitdir, "objects", oid.slice(0, 2), oid.slice(2));
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function temporaryPath(gitdir: string): string {
  return path.join(gitdir, `tmp_${randomUUID()}`);
}

/** Whether an object is in the store. An empty file is what a power cut can leave of one, and counts as none. */
async function stored(target: string): Promise<boolean> {
  return await lstat(target).then(
    (stats) => stats.size > 0,
    () => false,
  );
}

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(
    () => true,
    () => false,
  );
}
