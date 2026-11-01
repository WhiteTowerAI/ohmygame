import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { PluginIndex } from "./plugin-index.js";
import { MIME } from "./preview-static.js";

// Serves plugins' pages to their sandboxed frames. It is its own
// server, on its own port and with no daemon token, so a page can't reach the
// daemon's routes even as a same-origin request. Only a declared panel's
// folder and the package's `assets/` are served, and every page gets a CSP
// that allows the package's own files and the app's plugin-ui files: no
// remote scripts, no `eval`, no network, no forms.
//
//   /<publisher>/<name>/<version>/<file>   a plugin's files
//   /_ohmygame/plugin-ui.css, .js          the shared styles and bridge

const SDK_FILES = new Set(["plugin-ui.css", "plugin-ui.js"]);
const SDK_SOURCES: Record<string, string> = {
  "plugin-ui.css": "plugin-ui.css",
  "plugin-ui.js": "index.js",
};

export interface PluginUiServer {
  url: string;
  /** Where a panel's page is, or undefined when the plugin has no such panel. */
  panelUrl(id: string, version: string, panel: string): string | undefined;
  close(): Promise<void>;
}

export async function startPluginUiServer({
  index,
  sdkDirectory,
  frameAncestors = [],
  port = 0,
}: {
  index: PluginIndex;
  /** The `@ohmygame/plugin-ui` package folder. */
  sdkDirectory: string;
  /** The app's origins, the only pages that may frame plugin pages. */
  frameAncestors?: readonly string[];
  port?: number;
}): Promise<PluginUiServer> {
  let origin = "";
  const policy = (base: string) =>
    [
      "default-src 'none'",
      `script-src ${base} ${origin}/_ohmygame/`,
      `style-src ${base} ${origin}/_ohmygame/ 'unsafe-inline'`,
      `img-src ${base} data: blob:`,
      `media-src ${base} blob:`,
      `font-src ${base} ${origin}/_ohmygame/`,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`,
    ].join("; ");

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        outgoing.writeHead(405).end();
        return;
      }
      const pathname = decodeURIComponent(
        new URL(incoming.url ?? "/", "http://localhost").pathname,
      );
      const parts = pathname.split("/").slice(1);
      if (parts.some((part) => !part || part.startsWith(".") || part.includes("\\"))) {
        outgoing.writeHead(404).end();
        return;
      }
      let file: string;
      let csp: string | undefined;
      if (parts[0] === "_ohmygame") {
        if (parts.length !== 2 || !SDK_FILES.has(parts[1]!)) {
          outgoing.writeHead(404).end();
          return;
        }
        file = path.join(sdkDirectory, SDK_SOURCES[parts[1]!]!);
      } else {
        const [publisher, name, version, ...rest] = parts;
        const entry =
          publisher && name && version
            ? index.get(`${publisher}/${name}`, version)
            : undefined;
        const relative = rest.join("/");
        if (!entry || !rest.length || !servable(entry.manifest, relative)) {
          outgoing.writeHead(404).end();
          return;
        }
        const root = await realpath(entry.root);
        // A link could point anywhere; plugin pages are plain files and
        // folders, so no part of the path may be a link.
        file = root;
        for (const part of rest) {
          file = path.join(file, part);
          if ((await lstat(file)).isSymbolicLink()) throw new Error("link");
        }
        csp = policy(`${origin}/${publisher}/${name}/${version}/`);
      }
      const stats = await stat(file);
      if (!stats.isFile()) throw new Error("not a file");
      outgoing.writeHead(200, {
        "content-type":
          MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(stats.size),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cross-origin-opener-policy": "same-origin",
        // Pages have an opaque origin, so their module scripts are CORS
        // requests. These files are public and sent without credentials.
        "access-control-allow-origin": "*",
        ...(csp ? { "content-security-policy": csp } : {}),
      });
      if (incoming.method === "HEAD") {
        outgoing.end();
        return;
      }
      const stream = createReadStream(file);
      stream.on("error", () => outgoing.destroy());
      outgoing.once("close", () => stream.destroy());
      stream.pipe(outgoing);
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(404);
      outgoing.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    panelUrl(id, version, panel) {
      const entry = index.get(id, version);
      const declared = entry?.manifest.contributes?.panels?.find(
        (item) => item.id === panel,
      );
      return declared
        ? `${origin}/${id}/${version}/${declared.entry.replace(/^\.\//, "")}`
        : undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A declared panel's folder and the package's assets; never the manifest or native code. */
function servable(
  manifest: NonNullable<ReturnType<PluginIndex["get"]>>["manifest"],
  relative: string,
): boolean {
  if (relative.startsWith("assets/")) return true;
  return (manifest.contributes?.panels ?? []).some((panel) => {
    const folder = path.posix.dirname(panel.entry.replace(/^\.\//, ""));
    return folder === "." ? relative === panel.entry.replace(/^\.\//, "") : relative.startsWith(`${folder}/`);
  });
}
