import photon from "@silvia-odwyer/photon-node";

/** Read images are resent with every later model request, so send opaque ones as JPEG like game_use captures. */
const JPEG_QUALITY = 80;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ImageBlock { type: "image"; data: string; mimeType: string }
interface TextBlock { type: "text"; text: string }

/**
 * Re-encode opaque PNG image blocks as JPEG at the same size. Transparent PNGs keep their format,
 * and a JPEG that is not smaller than the PNG is discarded.
 */
export function opaquePngsAsJpeg<T extends { content: unknown[] }>(result: T): T {
  const content = result.content.map((block) => {
    if (!isImage(block) || block.mimeType !== "image/png") return block;
    const bytes = Buffer.from(block.data, "base64");
    if (!isOpaquePng(bytes)) return block;
    const jpeg = encodeJpeg(bytes);
    if (!jpeg || jpeg.length >= bytes.length) return block;
    return { ...block, data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" };
  });
  if (content.every((block, index) => block === result.content[index])) return result;
  return {
    ...result,
    content: content.map((block) => isText(block) ? { ...block, text: block.text.replace("Read image file [image/png]", "Read image file [image/jpeg]") } : block),
  };
}

/** Whether a PNG has neither an alpha channel nor tRNS transparency, read from its chunks. */
export function isOpaquePng(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return false;
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") return false;
    if (type === "IDAT" || type === "IEND") break;
    offset += bytes.readUInt32BE(offset) + 12;
  }
  return true;
}

function encodeJpeg(bytes: Buffer): Uint8Array | undefined {
  let image: photon.PhotonImage | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(bytes);
    return image.get_bytes_jpeg(JPEG_QUALITY);
  } catch {
    return undefined;
  } finally {
    image?.free();
  }
}

function isImage(block: unknown): block is ImageBlock {
  return typeof block === "object" && block !== null && (block as ImageBlock).type === "image" && typeof (block as ImageBlock).data === "string";
}

function isText(block: unknown): block is TextBlock {
  return typeof block === "object" && block !== null && (block as TextBlock).type === "text" && typeof (block as TextBlock).text === "string";
}
