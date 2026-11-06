import { readdir, mkdir, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import sharp from "sharp";

const inputExtensions = new Set([".png", ".jpg", ".jpeg"]);

function usage() {
  console.log(`Usage: node scripts/png-to-webp.mjs <image|directory> [output.webp|directory] [options]

Options:
  --quality <1-100>  WebP quality (default: 80; lower means more compression)
  --effort <0-6>     Compression effort (default: 4; higher is slower)
  --overwrite        Replace existing WebP files
  --help             Show this help

PNG, JPG, and JPEG files are supported. Directories are processed recursively.
Without an output path, WebP files are created beside the source images.
When source names collide, the original extension is kept (e.g. attack.jpg.webp).
Source images are never changed.`);
}

function integerOption(name, value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function parseArgs(args) {
  const paths = [];
  const options = { quality: 80, effort: 4, overwrite: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--quality" || arg === "--effort") {
      const value = args[++i];
      options[arg.slice(2)] = integerOption(
        arg,
        value,
        arg === "--quality" ? 1 : 0,
        arg === "--quality" ? 100 : 6,
      );
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      paths.push(arg);
    }
  }
  if (paths.length < 1 || paths.length > 2)
    throw new Error("Expected an input path and optional output path");
  return {
    input: resolve(paths[0]),
    output: paths[1] ? resolve(paths[1]) : undefined,
    ...options,
  };
}

async function* imageFiles(directory, relative = "") {
  for (const entry of await readdir(join(directory, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) yield* imageFiles(directory, path);
    else if (
      entry.isFile() &&
      inputExtensions.has(extname(entry.name).toLowerCase())
    )
      yield path;
  }
}

async function convert(input, output, options) {
  if (input === output) throw new Error("Input and output paths must differ");
  await mkdir(dirname(output), { recursive: true });
  const inputBytes = (await stat(input)).size;
  const webp = await sharp(input)
    .webp({ quality: options.quality, effort: options.effort })
    .toBuffer();
  await writeFile(output, webp, { flag: options.overwrite ? "w" : "wx" });
  const savings = ((1 - webp.length / inputBytes) * 100).toFixed(1);
  console.log(
    `${input} -> ${output} (${inputBytes} -> ${webp.length} bytes, ${savings}% saved)`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const source = await stat(options.input);
  if (source.isFile()) {
    if (!inputExtensions.has(extname(options.input).toLowerCase()))
      throw new Error("Input file must be a PNG, JPG, or JPEG");
    const output =
      options.output ??
      join(
        dirname(options.input),
        `${basename(options.input, extname(options.input))}.webp`,
      );
    if (extname(output).toLowerCase() !== ".webp")
      throw new Error("Output file must have a .webp extension");
    await convert(options.input, output, options);
  } else if (source.isDirectory()) {
    const outputDirectory = options.output ?? options.input;
    const relativeOutput = relative(options.input, outputDirectory);
    if (
      options.output &&
      !relativeOutput.startsWith("..") &&
      !isAbsolute(relativeOutput)
    ) {
      throw new Error("Output directory must be outside the input directory");
    }
    const conversions = [];
    const targets = new Map();
    for await (const relativePath of imageFiles(options.input)) {
      const output = join(
        outputDirectory,
        relativePath.slice(0, -extname(relativePath).length) + ".webp",
      );
      const key = output.normalize("NFC").toLowerCase();
      targets.set(key, (targets.get(key) ?? 0) + 1);
      conversions.push({ input: join(options.input, relativePath), output });
    }
    const usedTargets = new Set(targets.keys());
    for (const conversion of conversions) {
      const key = conversion.output.normalize("NFC").toLowerCase();
      if (targets.get(key) < 2) continue;
      const originalOutput = conversion.output;
      const sourceExtension = extname(conversion.input);
      let output = originalOutput.slice(0, -5) + sourceExtension + ".webp";
      let suffix = 2;
      while (usedTargets.has(output.normalize("NFC").toLowerCase())) {
        output =
          originalOutput.slice(0, -5) + sourceExtension + `-${suffix++}.webp`;
      }
      usedTargets.add(output.normalize("NFC").toLowerCase());
      conversion.output = output;
    }
    for (const { input, output } of conversions)
      await convert(input, output, options);
    console.log(
      `Converted ${conversions.length} image file${conversions.length === 1 ? "" : "s"}.`,
    );
  } else {
    throw new Error("Input must be a PNG, JPG, JPEG, or directory");
  }
}

main().catch((error) => {
  console.error(`Image to WebP: ${error.message}`);
  process.exitCode = 1;
});
