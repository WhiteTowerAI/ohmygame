import assert from "node:assert/strict";
import path from "node:path";
import { stat } from "node:fs/promises";
import checkPackagedDesktop from "./check-packaged-desktop.mjs";

// Reuse the package checks after installing the actual artifact outside the
// checkout. Missing installer payloads must fail before anything is published.
const installed = path.resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass the installed application directory");
assert(["darwin", "win32"].includes(process.platform), "Run on the target OS");
assert((await stat(installed)).isDirectory(), "Installed app is missing");
await checkPackagedDesktop({
  electronPlatformName: process.platform,
  appOutDir: installed,
  packager: {
    info: { appDir: process.cwd() },
    appInfo: { productFilename: "OhMyGame" },
    getResourcesDir: () =>
      path.join(
        installed,
        ...(process.platform === "darwin"
          ? ["Contents", "Resources"]
          : ["resources"]),
      ),
  },
});
