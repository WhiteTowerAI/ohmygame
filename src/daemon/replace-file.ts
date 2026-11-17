import { rename } from "node:fs/promises";

/** The errors Windows gives while another handle has either file open. */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Moves a finished temporary file over its destination. Windows refuses the
 * move while another handle has either file open, such as a virus scanner
 * reading the new file or a reader of the last save, so there it is tried
 * again for about a second before the error is kept.
 */
export async function replaceFile(
  temporary: string,
  destination: string,
  { platform = process.platform, move = rename }: { platform?: NodeJS.Platform; move?: typeof rename } = {},
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await move(temporary, destination);
    } catch (cause) {
      if (platform !== "win32" || attempt === 5 || !BUSY.has((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}
