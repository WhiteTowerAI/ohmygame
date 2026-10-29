import { cp } from "node:fs/promises";
import path from "node:path";

/** Keep module resolution from finding dependencies in the build checkout. */
export async function isolateDesktopArchive(archive, directory) {
  const isolated = path.join(directory, "app.asar");
  await cp(archive, isolated);
  try {
    await cp(`${archive}.unpacked`, `${isolated}.unpacked`, {
      recursive: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return isolated;
}
