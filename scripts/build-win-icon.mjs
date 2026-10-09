// Converts build/icon-windows.svg into build/icon.ico with multiple sizes.
// Run with: npm run build:win-icon
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const source = join(root, "build/icon-windows.svg");
const output = join(root, "build/icon.ico");

const sizes = [256, 128, 64, 48, 32, 16];

const pngBuffers = await Promise.all(
  sizes.map(async (size) => {
    const png = await sharp(source).resize(size, size).png().toBuffer();
    return { size, buffer: png };
  }),
);

// ICO file format: 6-byte header + 16-byte entry per image + image data
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: ICO
header.writeUInt16LE(pngBuffers.length, 4); // image count

const entries = Buffer.alloc(16 * pngBuffers.length);
const dataBuffers = [];
let dataOffset = 6 + 16 * pngBuffers.length;

for (let i = 0; i < pngBuffers.length; i++) {
  const { size, buffer } = pngBuffers[i];
  const offset = dataOffset;
  dataBuffers.push(buffer);
  dataOffset += buffer.length;

  entries.writeUInt8(size === 256 ? 0 : size, i * 16 + 0); // width (0 = 256)
  entries.writeUInt8(size === 256 ? 0 : size, i * 16 + 1); // height
  entries.writeUInt8(0, i * 16 + 2); // color palette
  entries.writeUInt8(0, i * 16 + 3); // reserved
  entries.writeUInt16LE(1, i * 16 + 4); // color planes
  entries.writeUInt16LE(32, i * 16 + 6); // bits per pixel
  entries.writeUInt32LE(buffer.length, i * 16 + 8); // image size
  entries.writeUInt32LE(offset, i * 16 + 12); // image offset
}

const ico = Buffer.concat([header, entries, ...dataBuffers]);
writeFileSync(output, ico);

console.log(`Generated ${output} with sizes: ${sizes.join(", ")}`);
