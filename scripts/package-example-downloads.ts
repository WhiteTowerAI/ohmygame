import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { ZipFile } from "yazl";
import { compressArchiveFile } from "../src/daemon/archive-compression.js";
import {
  EXAMPLE_ARCHIVE_MAX_BYTES,
  EXAMPLE_ARCHIVE_MAX_ENTRIES,
  exampleArchiveKey,
  isExampleArchive,
  isPreparedExampleCatalog,
  type ExampleArchive,
  type ExampleArchiveManifest,
} from "../src/shared/examples.js";
import { replaceDirectory } from "./runtime-directory.js";

const root = path.resolve(import.meta.dirname, "..");
const bundled = path.join(root, "resources", "examples");
const runtime = path.join(root, ".runtime");
const prepared = path.join(runtime, "examples");
const catalog: unknown = JSON.parse(await readFile(path.join(bundled, "catalog.json"), "utf8"));
const full: unknown = JSON.parse(await readFile(path.join(prepared, "catalog.json"), "utf8"));
if (!isPreparedExampleCatalog(catalog) || catalog.version !== 2 || !isPreparedExampleCatalog(full) || full.version !== 1
  || !isDeepStrictEqual(catalog.source, full.source) || !isDeepStrictEqual(catalog.examples, full.examples)) {
  throw new Error("The bundled example catalog does not match the pinned repository");
}
for (const example of catalog.examples) {
  const cover = await readFile(path.join(bundled, example.cover));
  if (!cover.equals(await readFile(path.join(prepared, example.cover)))) {
    throw new Error(`The bundled cover for ${example.id} does not match the pinned repository`);
  }
}

const staging = await mkdtemp(path.join(runtime, "example-downloads-"));
const commit = catalog.source.commit;
const output = path.join(staging, commit);
const manifest: ExampleArchiveManifest = { version: 1, commit, archives: {} };
try {
  await mkdir(output);
  for (const example of catalog.examples) {
    manifest.archives[exampleArchiveKey(example.id, "files")] = await pack(path.join(prepared, example.directory));
    if (example.play) manifest.archives[exampleArchiveKey(example.id, "play")] = await pack(path.join(prepared, example.play));
  }
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await replaceDirectory(staging, path.join(runtime, "example-downloads"));
  console.log(`Packaged ${Object.keys(manifest.archives).length} example downloads for ${commit}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function pack(directory: string): Promise<ExampleArchive> {
  const pending = path.join(output, "pending.zip");
  const zip = new ZipFile();
  zip.on("error", (error) => zip.outputStream.destroy(error));
  let entries = 0;
  let bytes = 0;
  const options = { mtime: new Date(1980, 0, 2), forceDosTimestamp: true };
  async function add(relative: string): Promise<void> {
    const folder = path.join(directory, relative);
    const children = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    if (relative && children.length === 0) {
      entries++;
      zip.addEmptyDirectory(relative, options);
    }
    for (const child of children) {
      const entry = relative ? `${relative}/${child.name}` : child.name;
      const file = path.join(directory, entry);
      if (child.isDirectory()) {
        await add(entry);
      } else if (child.isFile()) {
        const info = await stat(file);
        entries++;
        bytes += info.size;
        zip.addFile(file, entry, {
          ...options,
          mode: (info.mode & 0o111) !== 0 ? 0o100755 : 0o100644,
          compress: compressArchiveFile(entry),
        });
      } else {
        throw new Error(`Unsupported example file: ${file}`);
      }
      if (entries > EXAMPLE_ARCHIVE_MAX_ENTRIES || bytes > EXAMPLE_ARCHIVE_MAX_BYTES) {
        throw new Error(`Example archive exceeds size or entry limits: ${directory}`);
      }
    }
  }
  await add("");
  const written = pipeline(zip.outputStream, createWriteStream(pending, { flags: "wx" }));
  zip.end();
  await written;
  const hash = createHash("sha256");
  await pipeline(createReadStream(pending), hash);
  const record = { sha256: hash.digest("hex"), bytes: (await stat(pending)).size };
  if (!isExampleArchive(record)) throw new Error(`Invalid example archive: ${directory}`);
  await rename(pending, path.join(output, `${record.sha256}.zip`));
  return record;
}
