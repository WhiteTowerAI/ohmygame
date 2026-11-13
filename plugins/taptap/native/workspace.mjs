import { readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";

// Bounded discovery is a convenience, never authority to upload. Packaging
// independently validates the chosen directory and every member again.
export async function discoverWorkspace(workspace) {
  workspace = await realpath(workspace);
  const builds = [],
    images = [];
  let visited = 0,
    truncated = false;
  const walk = async (directory, depth) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 4000) {
        truncated = true;
        return;
      }
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith(".") ||
        ["node_modules", "vendor", "coverage"].includes(entry.name)
      )
        continue;
      const absolute = path.join(directory, entry.name);
      const relative = path
        .relative(workspace, absolute)
        .split(path.sep)
        .join("/");
      if (entry.isDirectory()) {
        if (depth < 4) await walk(absolute, depth + 1);
        else truncated = true;
      } else if (entry.isFile()) {
        if (entry.name === "index.html") {
          const folder = path.posix.dirname(relative);
          builds.push({
            folder,
            modifiedAt: (await lstat(absolute)).mtime.toISOString(),
            suggested: /(^|\/)(dist|build|export|web|www)(\/|$)/i.test(folder),
          });
        }
        if (/\.(png|jpe?g|webp)$/i.test(entry.name) && images.length < 120)
          images.push({ path: relative, name: entry.name });
      }
    }
  };
  await walk(await realpath(workspace), 0);
  return {
    builds: builds.sort(
      (a, b) =>
        Number(b.suggested) - Number(a.suggested) ||
        a.folder.localeCompare(b.folder),
    ),
    images,
    truncated,
  };
}

export async function fetchStoreImage(address) {
  const url = new URL(address);
  if (
    url.protocol !== "https:" ||
    !["img.tapimg.com", "img-tc.tapimg.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error(
      "Image preview is only available for the official TapTap image host",
    );
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Image preview failed (${response.status})`);
  const type = response.headers.get("content-type")?.split(";")[0];
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type))
    throw new Error("Unsupported image preview format");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 5 * 1024 * 1024)
      throw new Error("Image exceeds the 5 MB preview limit");
    chunks.push(chunk);
  }
  return {
    src: `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`,
  };
}
