import { shell } from "electron";

/**
 * Opens a link a page asked to open in a new window. The page has nothing to
 * report a failure to, so a system without a browser for the link (Windows
 * "no application is associated") is logged instead of left unhandled.
 */
export async function openInBrowser(url: string): Promise<void> {
  try {
    await shell.openExternal(url);
  } catch (error) {
    console.warn(
      `Could not open ${url} in the browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
