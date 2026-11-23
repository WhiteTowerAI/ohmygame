import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PLUGIN_UI_MAJORS, PLUGIN_UI_PREVIEW_MAJORS } from "../shared/plugin-ui-versions.js";
import type { PluginIndex } from "./plugin-index.js";
import { MIME } from "./preview-static.js";

// Serves plugins' pages to their sandboxed frames. It is its own
// server, on its own port and with no daemon token, so a page can't reach the
// daemon's routes even as a same-origin request. Only a declared panel's
// folder and the package's `assets/` are served, and every page gets a CSP
// that allows the package's own files and the app's plugin-ui files: no
// remote scripts, no `eval`, no forms, and no network but `fetch` of its own
// files (API 2.35.0).
//
//   /<publisher>/<name>/<version>/<file>   a plugin's files
//   /_project/<project id>/<panel>/<file>  a project panel's files, once allowed
//   /_copy/<project id>/<publisher>/<name>/<file>  the files of a plugin a project carries, while it uses it
//   /_draft/<workspace id>/<file>          a Plugin Builder draft's files, as it stands now
//   /_modules/<token>/<revision>/<file>    a project's modules a plugin's pages import (`ui.projectModules`)
//   /_ohmygame/plugin-ui.css, .js          the shared styles and bridge
//   /_ohmygame/ui/<major>/<file>.js        the page components, by major version

const SDK_FILES = new Set(["plugin-ui.css", "plugin-ui.js"]);
const SDK_SOURCES: Record<string, string> = {
  "plugin-ui.css": "plugin-ui.css",
  "plugin-ui.js": "index.js",
};
const UI_MAJORS = new Set(PLUGIN_UI_MAJORS);
const UI_FILE = /^[a-z0-9-]{1,64}\.js$/;
/** What a page may import from its project: scripts, nothing it would read as data. */
const MODULE_FILE = /\.m?js$/i;

export interface PluginUiServer {
  url: string;
  /** Where a panel's page is, or undefined when the plugin has no such panel. */
  panelUrl(id: string, version: string, panel: string): string | undefined;
  /**
   * The token a page's address carries as `modules` so the page may import
   * a project's modules: one for each `key`, such as a project and a plugin's
   * version, and only for pages of `owner` (`publisher/name`, or
   * `_draft/<workspace id>`). `resolve` says where they are, each time it is
   * asked, or undefined once the page may no longer import them.
   */
  modulesToken(key: string, owner: string, resolve: ModulesResolver): string;
  /** Where a panel's page is in a plugin a project carries; `revision` makes a changed page load again. */
  copyPanelUrl(projectId: string, entry: { id: string; digest: string; manifest: PluginManifest }, panel: string): string | undefined;
  /** Where a project panel's page is; `revision` makes a changed page load again. */
  projectPanelUrl(projectId: string, panel: string, entry: string, revision: string): string;
  /** Where a draft's panel's page is, in its workspace; `revision` makes a changed page load again. */
  draftPanelUrl(setupId: string, manifest: PluginManifest, panel: string, revision: string): string | undefined;
  close(): Promise<void>;
}

export async function startPluginUiServer({
  index,
  sdkDirectory,
  frameAncestors = [],
  port = 0,
  projectPanel = async () => undefined,
  projectCopy = async () => undefined,
  draftPackage = async () => undefined,
}: {
  index: PluginIndex;
  /** The plugin a project carries, while the project uses it. */
  projectCopy?: (projectId: string, id: string) => Promise<{ root: string; manifest: PluginManifest } | undefined>;
  /** The folder of a project's panel that the person allowed, or undefined. */
  projectPanel?: (projectId: string, panel: string) => Promise<string | undefined>;
  /** A Plugin Builder workspace's draft as it stands, when it passes its checks. */
  draftPackage?: (setupId: string) => Promise<{ root: string; manifest: PluginManifest } | undefined>;
  /** The `@ohmygame/plugin-ui` package folder. */
  sdkDirectory: string;
  /** The app's origins, the only pages that may frame plugin pages. */
  frameAncestors?: readonly string[];
  port?: number;
}): Promise<PluginUiServer> {
  let origin = "";
  // Project modules by an unguessable token, which only the app hands a page:
  // the page server has no sign-in, and a project's code is the person's.
  const modules = new Map<string, { owner: string; resolve: ModulesResolver; checked?: { at: number; value: ReturnType<ModulesResolver> } }>();
  const tokens = new Map<string, string>();
  /**
   * Where a token's modules are, checked again at most once a second, as one
   * import may bring many: they share one check, even while it runs.
   */
  const located = (token: string) => {
    const found = modules.get(token);
    if (!found) return undefined;
    if (!found.checked || Date.now() - found.checked.at >= 1_000)
      found.checked = { at: Date.now(), value: found.resolve().catch(() => undefined) };
    return found.checked.value;
  };
  const policy = (base: string, preview: boolean, modules?: string) =>
    [
      "default-src 'none'",
      // Components in preview load only for a plugin that opts in.
      `script-src ${base} ${modules ? `${modules} ` : ""}${origin}/_ohmygame/plugin-ui.js ${[...UI_MAJORS]
        .filter((major) => preview || !PLUGIN_UI_PREVIEW_MAJORS.has(major))
        .map((major) => `${origin}/_ohmygame/ui/${major}/`)
        .join(" ")}`.trimEnd(),
      `style-src ${base} ${origin}/_ohmygame/plugin-ui.css 'unsafe-inline'`,
      `img-src ${base} data: blob:`,
      `media-src ${base} blob:`,
      `font-src ${base}`,
      // Its own files only, such as presets or data that come with it; the server answers only GET and HEAD.
      `connect-src ${base}`,
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`,
    ].join("; ");

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      // A page's fetch with headers of its own asks first; it may read, as a plain fetch may.
      if (incoming.method === "OPTIONS" && incoming.headers.origin === "null" && incoming.headers["access-control-request-method"] && ["GET", "HEAD"].includes(incoming.headers["access-control-request-method"])) {
        const headers = incoming.headers["access-control-request-headers"];
        outgoing.writeHead(204, {
          "access-control-allow-origin": "null",
          "access-control-allow-methods": "GET, HEAD",
          ...(headers ? { "access-control-allow-headers": headers } : {}),
          "access-control-max-age": "600",
        }).end();
        return;
      }
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
      /** Who may read it: anyone for an installed package's files, which are public; only a sandboxed page for a project's or a draft's. */
      let readers = "*";
      if (parts[0] === "_ohmygame") {
        const [, first, major, name] = parts;
        if (parts.length === 2 && SDK_FILES.has(first!))
          file = path.join(sdkDirectory, SDK_SOURCES[first!]!);
        else if (parts.length === 4 && first === "ui" && UI_MAJORS.has(major!) && UI_FILE.test(name!))
          file = path.join(sdkDirectory, "ui", major!, name!);
        else {
          outgoing.writeHead(404).end();
          return;
        }
      } else if (parts[0] === "_project") {
        const [, projectId, panel, ...rest] = parts;
        const root = projectId && panel && rest.length ? await projectPanel(projectId, panel) : undefined;
        if (!root) {
          outgoing.writeHead(404).end();
          return;
        }
        file = await realpath(root);
        for (const part of rest) {
          file = path.join(file, part);
          if ((await lstat(file)).isSymbolicLink()) throw new Error("link");
        }
        csp = policy(`${origin}/_project/${projectId}/${panel}/`, false);
        readers = "null";
      } else if (parts[0] === "_copy") {
        const [, projectId, publisher, name, ...rest] = parts;
        const relative = rest.join("/");
        const copy = projectId && publisher && name && rest.length ? await projectCopy(projectId, `${publisher}/${name}`) : undefined;
        if (!copy || !servable(copy.manifest, relative)) {
          outgoing.writeHead(404).end();
          return;
        }
        file = await packageFile(copy.root, rest);
        // The project's, like a draft: not a published package.
        readers = "null";
        csp = policy(`${origin}/_copy/${projectId}/${publisher}/${name}/`, copy.manifest.ui?.preview === true, modulesSource(incoming.url, `${publisher}/${name}`));
      } else if (parts[0] === "_modules") {
        // The revision is the page's own, so a page imports a changed module, and what it imports, again.
        const [, token, revision, ...rest] = parts;
        const allowed = token && revision && rest.length && MODULE_FILE.test(rest.at(-1)!) ? await located(token) : undefined;
        const relative = rest.join("/");
        if (!allowed || !allowed.folders.some((folder) => relative.startsWith(`${folder}/`))) {
          outgoing.writeHead(404).end();
          return;
        }
        file = await packageFile(allowed.root, rest);
        readers = "null";
      } else if (parts[0] === "_draft") {
        const [, setupId, ...rest] = parts;
        const relative = rest.join("/");
        const draft = setupId && rest.length ? await draftPackage(setupId) : undefined;
        if (!draft || !servable(draft.manifest, relative)) {
          outgoing.writeHead(404).end();
          return;
        }
        file = await packageFile(draft.root, rest);
        // A draft is the person's work in progress, not a published package.
        readers = "null";
        csp = policy(`${origin}/_draft/${setupId}/`, draft.manifest.ui?.preview === true, modulesSource(incoming.url, `_draft/${setupId}`));
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
        file = await packageFile(entry.root, rest);
        csp = policy(
          `${origin}/${publisher}/${name}/${version}/`,
          entry.manifest.ui?.preview === true,
          modulesSource(incoming.url, entry.id),
        );
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
        "access-control-allow-origin": readers,
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
  /**
   * The CSP source for the modules a page's address names, when they are its
   * plugin's. Whether it may import them now is the module route's to say, at
   * each import, so a check that fails while the page loads never locks it out.
   */
  function modulesSource(url: string | undefined, owner: string) {
    const token = new URL(url ?? "/", "http://localhost").searchParams.get("modules");
    return token && modules.get(token)?.owner === owner ? `${origin}/_modules/${token}/` : undefined;
  }
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
    modulesToken(key, owner, resolve) {
      let token = tokens.get(key);
      if (!token) {
        token = randomBytes(18).toString("base64url");
        tokens.set(key, token);
      }
      modules.set(token, { owner, resolve });
      return token;
    },
    copyPanelUrl(projectId, entry, panel) {
      const declared = entry.manifest.contributes?.panels?.find((item) => item.id === panel);
      return declared
        ? `${origin}/_copy/${encodeURIComponent(projectId)}/${entry.id}/${declared.entry.replace(/^\.\//, "")}?revision=${entry.digest.slice(0, 16)}`
        : undefined;
    },
    projectPanelUrl: (projectId, panel, entry, revision) =>
      `${origin}/_project/${encodeURIComponent(projectId)}/${panel}/${entry}?revision=${revision}`,
    draftPanelUrl: (setupId, manifest, panel, revision) => {
      const declared = manifest.contributes?.panels?.find((item) => item.id === panel);
      return declared
        ? `${origin}/_draft/${encodeURIComponent(setupId)}/${declared.entry.replace(/^\.\//, "")}?revision=${revision}`
        : undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

type PluginManifest = NonNullable<ReturnType<PluginIndex["get"]>>["manifest"];

/** Where a page's project modules are: the project's folder and the folders in it it may import from. */
export type ModulesResolver = () => Promise<{ root: string; folders: string[] } | undefined>;

/**
 * A file of a package by the parts of its path. A link could point anywhere;
 * plugin pages are plain files and folders, so no part of the path may be a link.
 */
async function packageFile(packageRoot: string, parts: readonly string[]): Promise<string> {
  let file = await realpath(packageRoot);
  for (const part of parts) {
    file = path.join(file, part);
    if ((await lstat(file)).isSymbolicLink()) throw new Error("link");
  }
  return file;
}

/** A declared panel's folder and the package's assets; never the manifest or native code. */
function servable(
  manifest: PluginManifest,
  relative: string,
): boolean {
  if (relative.startsWith("assets/")) return true;
  return (manifest.contributes?.panels ?? []).some((panel) => {
    const folder = path.posix.dirname(panel.entry.replace(/^\.\//, ""));
    return folder === "." ? relative === panel.entry.replace(/^\.\//, "") : relative.startsWith(`${folder}/`);
  });
}
