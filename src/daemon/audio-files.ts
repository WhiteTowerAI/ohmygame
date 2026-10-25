import { randomUUID } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import { audioCompanionFiles, type AudioAssetData } from "../shared/audio.js";

/** Companions live beside the materialized audio, so project archives retain them. */
export async function writeAudioCompanions(
  file: string,
  data: AudioAssetData,
): Promise<void> {
  for (const companion of audioCompanionFiles(file, data)) {
    const temporary = `${companion.name}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, companion.text, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, companion.name);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
