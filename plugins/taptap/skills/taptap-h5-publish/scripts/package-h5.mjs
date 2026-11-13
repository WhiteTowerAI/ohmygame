// Standalone Node helper: plugins cannot depend on the host's node_modules.
// Write streaming ZIP32 (DEFLATE + data descriptors), with one game/ root.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createDeflateRaw, crc32 } from "node:zlib";

const ZIP32_MAX = 0xffffffff;
const metadata = (name) =>
  name === "__MACOSX" || name === ".DS_Store" || name.startsWith("._");
const sourceOnly = (name) =>
  [".git", ".hg", ".svn", "node_modules", ".env"].includes(name) ||
  name.startsWith(".env.");
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};

async function filesIn(directory, prefix = "", files = [], warnings = []) {
  for (const name of (await readdir(directory)).sort()) {
    if (metadata(name)) continue;
    const relative = prefix ? `${prefix}/${name}` : name;
    if (sourceOnly(name))
      throw new Error(
        `Source or credential file in build: ${relative}. Choose a clean production build.`,
      );
    if (name.includes("\\") || /[\x00-\x1f]/.test(name))
      throw new Error(`Unsupported archive filename: ${relative}`);
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    if (info.isSymbolicLink())
      throw new Error(`Symbolic links are not supported: ${relative}`);
    if (name.startsWith("."))
      warnings.push(`Review hidden build entry: ${relative}`);
    if (info.isDirectory()) await filesIn(filename, relative, files, warnings);
    else if (info.isFile()) files.push({ filename, relative });
    else throw new Error(`Not a regular build file: ${relative}`);
  }
  return { files, warnings };
}

export async function packageH5(
  buildFolder,
  outputZip,
  workspace = process.cwd(),
) {
  const root = await realpath(workspace);
  const sourcePath = path.resolve(root, buildFolder);
  if ((await lstat(sourcePath)).isSymbolicLink())
    throw new Error("Build folder must not be a symbolic link");
  const source = await realpath(sourcePath);
  const destination = path.resolve(root, outputZip);
  const parent = await realpath(path.dirname(destination));
  const output = path.join(parent, path.basename(destination));
  if (!inside(root, source) || !inside(root, output))
    throw new Error("Build and ZIP must be inside the game workspace");
  if (inside(source, output))
    throw new Error("ZIP output must be outside the build folder");
  if (!output.toLowerCase().endsWith(".zip"))
    throw new Error("Output must have a .zip extension");
  const { files, warnings } = await filesIn(source);
  if (!files.some((file) => file.relative === "index.html"))
    throw new Error("Build folder must contain index.html directly inside it");
  if (files.length >= 65535)
    throw new Error("Build exceeds the ZIP32 file count limit");

  // Exclusive creation preserves existing packages and coordinates concurrent runs.
  const archive = await open(output, "wx", 0o600);
  let position = 0;
  const hash = createHash("sha256");
  const write = async (buffer) => {
    if (position + buffer.length >= ZIP32_MAX)
      throw new Error("Build requires ZIP64; this helper supports ZIP32 only");
    await archive.writeFile(buffer);
    hash.update(buffer);
    position += buffer.length;
  };
  try {
    const directory = [];
    for (const file of files) {
      const name = Buffer.from(`game/${file.relative}`, "utf8");
      if (name.length > 65535)
        throw new Error(`Archive filename is too long: ${file.relative}`);
      const offset = position;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0808, 6); // UTF-8 and trailing data descriptor.
      header.writeUInt16LE(8, 8); // DEFLATE.
      header.writeUInt16LE(33, 12); // 1980-01-01; stable archives across rebuilds.
      header.writeUInt16LE(name.length, 26);
      await write(header);
      await write(name);
      const start = position;
      let checksum = 0;
      let size = 0;
      const input = await open(
        file.filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        if (!(await input.stat()).isFile())
          throw new Error(`Build file changed: ${file.relative}`);
        await pipeline(
          input.createReadStream({ autoClose: false }),
          async function* (chunks) {
            for await (const chunk of chunks) {
              size += chunk.length;
              if (size >= ZIP32_MAX)
                throw new Error(`Build file requires ZIP64: ${file.relative}`);
              checksum = crc32(chunk, checksum);
              yield chunk;
            }
          },
          createDeflateRaw(),
          async (chunks) => {
            for await (const chunk of chunks) await write(chunk);
          },
        );
      } finally {
        await input.close();
      }
      const compressed = position - start;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0808, 8);
      central.writeUInt16LE(8, 10);
      central.writeUInt16LE(33, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(compressed, 20);
      central.writeUInt32LE(size, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      directory.push(central, name);
    }
    const centralOffset = position;
    for (const entry of directory) await write(entry);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(position - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await write(end);
    await archive.close();
    return {
      path: output,
      sha256: hash.digest("hex"),
      bytes: position,
      files: files.length,
      warnings,
    };
  } catch (error) {
    await archive.close();
    await rm(output, { force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 4)
      throw new Error(
        "Usage: node package-h5.mjs <build-folder> <new-output.zip> (run in the game workspace)",
      );
    console.log(
      JSON.stringify({
        ok: true,
        data: await packageH5(process.argv[2], process.argv[3]),
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
