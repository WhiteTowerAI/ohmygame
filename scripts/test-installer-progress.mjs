import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  throw new Error(
    "This smoke test runs native Windows installer controls on Windows.",
  );
}
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".runtime", "windows-installer-progress");
const cache = path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache");
async function findTool(folder, name, depth = 0) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase())
      return full;
    if (entry.isDirectory() && depth < 4) {
      const found = await findTool(full, name, depth + 1);
      if (found) return found;
    }
  }
}
function run(exe, args) {
  const result = spawnSync(exe, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${exe}\n${result.stdout}\n${result.stderr}`);
}
const makensis =
  process.env.MAKENSIS ?? (await findTool(cache, "makensis.exe"));
const archive = process.env.SEVEN_ZIP ?? (await findTool(cache, "7za.exe"));
const plugin = await findTool(cache, "Nsis7z.dll");
assert.ok(
  makensis && archive && plugin,
  "Package for Windows first, or set MAKENSIS and SEVEN_ZIP; NSIS plugins must be cached.",
);
// Nsis7z has several architecture variants. The Unicode NSIS wizard uses x86.
const pluginDir = path.join(path.dirname(path.dirname(plugin)), "x86-unicode");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "payload.bin"), randomBytes(8 * 1024 * 1024));
run(archive, [
  "a",
  "-t7z",
  "-mx=1",
  path.join(output, "payload.7z"),
  path.join(output, "payload.bin"),
]);
const preview = process.argv.includes("--preview");
for (const [kind, language] of [
  ["success", 1033],
  ["failure", 2052],
]) {
  run(makensis, [
    "/V2",
    "/INPUTCHARSET",
    "UTF8",
    `/DPROJECT_DIR=${root}`,
    `/DOUTPUT_DIR=${output}`,
    `/DNSIS_PLUGIN_DIR=${pluginDir}`,
    `/DSMOKE_KIND=${kind}`,
    `/DSMOKE_LANGUAGE=${language}`,
    ...(preview ? ["/DPREVIEW"] : []),
    path.join(root, "test", "fixtures", "windows-installer-progress.nsi"),
  ]);
  const exe = path.join(output, `progress-${kind}.exe`);
  run(exe, []);
  const rows = (await readFile(path.join(output, `${kind}.log`), "utf16le"))
    .trim()
    .split("\r\n")
    .map((line) => line.split("|"));
  assert.deepEqual(
    rows.map((row) => Number(row[1])),
    [0, 47, 47, 47, 95, 99, kind === "success" ? 100 : 99],
  );
  for (const [, percent, position, text] of rows) {
    assert.equal(position, percent, "Visible bar and percentage must agree");
    assert.ok(text.includes(`${percent}%`), text);
    if (Number(percent) < 100) {
      assert.ok(
        text.startsWith(language === 1033 ? "Installing..." : "正在安装..."),
        text,
      );
    }
  }
  assert.match(
    rows.at(-1)[3],
    kind === "success" ? /Installation complete/ : /正在完成安装/,
  );
  run(exe, ["/S"]);
  console.log(
    `${kind}: monotonic percentage, actual extraction/copy, preserved stack/registers, and silent mode passed`,
  );
}
console.log(`Installer fixtures: ${output}`);
