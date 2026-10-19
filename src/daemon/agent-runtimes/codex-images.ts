import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { sniffImageType } from "../image-format.js";
import type { DriverContext } from "./driver-context.js";
import type { NativeToolResult } from "./native-session.js";
import { inside } from "./policy.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** The protocol carries Base64 bytes; some versions only retain a savedPath. Never fetch a URL. */
export async function importCodexImage(
  item: Record<string, unknown>,
  threadId: string,
  context: DriverContext,
): Promise<NativeToolResult> {
  let bytes: Buffer;
  if (typeof item.result === "string" && item.result) {
    const encoded = item.result.replace(
      /^data:image\/(?:png|jpeg|webp);base64,/,
      "",
    );
    if (
      encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw new Error("Codex returned invalid or oversized image data");
    bytes = Buffer.from(encoded, "base64");
  } else {
    // A file-only result may read exactly this thread's generated-images directory,
    // including its real path, never an arbitrary path supplied by the agent.
    const home =
      context.env.CODEX_HOME ||
      (context.env.HOME && path.join(context.env.HOME, ".codex"));
    if (
      !home ||
      !/^[A-Za-z0-9_-]+$/.test(threadId) ||
      typeof item.savedPath !== "string"
    )
      throw new Error("Codex returned no usable generated image");
    const root = path.join(await realpath(home), "generated_images", threadId);
    if ((await realpath(root)) !== root)
      throw new Error(
        "Codex generated-images directory resolves outside this thread",
      );
    const file = await realpath(item.savedPath);
    if (!inside(file, root))
      throw new Error(
        "Codex image is outside this thread's generated-images directory",
      );
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
        throw new Error("Codex returned an invalid or oversized image file");
      // Bound the read even if the source file grows after stat.
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size)
        throw new Error("Codex image changed while it was being imported");
      bytes = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  }
  const mediaType = sniffImageType(bytes);
  if (!mediaType || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Codex returned an unsupported or invalid image");
  if (!context.saveGeneratedImage)
    throw new Error("Project image import is unavailable");
  const extension =
    mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
  const identity = createHash("sha256")
    .update(threadId)
    .update("\0")
    .update(String(item.id))
    .update("\0")
    .update(bytes)
    .digest("hex")
    .slice(0, 24);
  const prompt =
    typeof item.revisedPrompt === "string" ? item.revisedPrompt : undefined;
  const relativePath = await context.saveGeneratedImage(
    `codex-${identity}.${extension}`,
    bytes,
    prompt,
  );
  return {
    content: [
      { type: "text", text: `Generated image saved to ${relativePath}` },
    ],
    details: { artifact: { type: "image", path: relativePath, mediaType } },
  };
}
