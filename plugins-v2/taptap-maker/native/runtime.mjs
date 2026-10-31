// Runs the pinned Maker CLI and prepares it in the plugin's data folder. The
// folder is shared by every project, each of which has its own host, so
// preparing takes a lock there.
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const MAKER_VERSION = "0.0.36";
export const LUA_LSP_VERSION = "0.22.2";
export const pythonPath = (directory) =>
  path.join(
    directory,
    "python",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
export const makerPath = (directory) =>
  path.join(
    directory,
    "tools",
    "node_modules",
    "@taptap",
    "maker",
    "bin",
    "taptap-maker",
  );
const AUTHORIZATION_MISSING =
  /(?:PAT|JWT) (?:missing|not found)|not logged|login.*required|unauthorized|HTTP 40[13]|token.*expired/i;
export const makerEnvironment = (directory) => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  TAPTAP_MAKER_DISTRIBUTION: "ohmygame_plugin",
  TAPTAP_MAKER_PYTHON_BIN: pythonPath(directory),
});

/** The error a cancelled call ends with. */
export class Cancelled extends Error {
  constructor() {
    super(
      "Cancelled. Maker may have finished part of the work; check the project's status before trying again.",
    );
  }
}

/** Stops a child and everything it started. */
function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32")
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).once("error", () => child.kill());
  else
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
}

export async function run(
  command,
  args,
  { env = process.env, cwd, onLine, signal } = {},
) {
  if (signal?.aborted) throw new Cancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group, so cancelling stops what Maker started too.
      detached: process.platform !== "win32",
    });
    let output = "";
    let pending = "";
    let failure;
    let diagnostic = "";
    let authorizationMissing = false;
    const abort = () => {
      failure = new Cancelled();
      stopTree(child);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
        failure = new Error("Maker output exceeded its limit");
        stopTree(child);
        return;
      }
      if (!onLine) return;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    });
    // Upstream stderr can include credentials. Only protocol messages reach
    // the person; never forward arbitrary CLI output.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-8192);
      authorizationMissing ||= AUTHORIZATION_MISSING.test(diagnostic);
    });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (onLine && pending.trim() && !failure) onLine(pending);
      if (failure) reject(failure);
      else resolve({ code, output, authorizationMissing });
    });
  });
}

async function cliInstalled(directory) {
  try {
    const metadata = JSON.parse(
      await readFile(
        path.join(directory, "tools/node_modules/@taptap/maker/package.json"),
        "utf8",
      ),
    );
    await access(makerPath(directory));
    return metadata.version === MAKER_VERSION;
  } catch {
    return false;
  }
}

/** Whether the pinned CLI and the diagnostics' Python are in place; reads files only. */
export async function installed(directory) {
  if (!(await cliInstalled(directory))) return false;
  try {
    await access(pythonPath(directory));
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the Maker CLI. With `report`, a failing command that still printed a
 * JSON object with a `state` (as `preview status` does for a failed preview)
 * returns it, so its own diagnosis can reach the person.
 */
export async function maker(
  directory,
  args,
  { onLine, report = false, signal } = {},
) {
  const result = await run(process.execPath, [makerPath(directory), ...args], {
    env: makerEnvironment(directory),
    onLine,
    signal,
  });
  if (result.code !== 0) {
    const reported =
      report && !result.authorizationMissing
        ? parseReport(result.output)
        : undefined;
    if (reported) return reported;
    // Known recovery categories are useful; raw upstream errors can contain a
    // token-bearing Git URL or account credentials and stay out of the UI.
    if (
      result.authorizationMissing ||
      AUTHORIZATION_MISSING.test(result.output)
    )
      throw new Error(
        "Maker authorization is missing or expired. Sign in again in the TapTap Maker panel.",
      );
    throw new Error(
      "Maker operation failed. Check the Maker connection and local project, then retry the requested action.",
    );
  }
  try {
    return JSON.parse(result.output);
  } catch {
    return undefined;
  } // init/login emit multiple progress records.
}

function parseReport(output) {
  try {
    const value = JSON.parse(output);
    return value && typeof value === "object" && typeof value.state === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

const SENSITIVE =
  /token|key|secret|signature|sig|auth|password|credential|session/i;

/**
 * Takes credentials out of a CLI message before it is shown: a URL's user
 * and password, and the values of query parameters whose decoded names look
 * like credentials. A URL that can't be parsed loses its query.
 */
export function redact(message) {
  // A URL runs to whitespace or a character it can't hold; an apostrophe may be part of a value.
  return String(message).replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"<>]+/gi,
    (text) => {
      let url;
      try {
        url = new URL(text);
      } catch {
        return text
          .replace(/^([^:]+:\/\/)[^/?#]*@/, "$1")
          .replace(/[?#].*$/, "");
      }
      const names = [...url.searchParams.keys()].filter((name) =>
        SENSITIVE.test(name),
      );
      if (!url.username && !url.password && !names.length) return text;
      url.username = "";
      url.password = "";
      for (const name of names) url.searchParams.set(name, "***");
      return url.href;
    },
  );
}

/** A lock held longer than this belongs to a host that died without letting go. */
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Runs `work` while holding a lock file in the data folder, waiting for
 * another project's host that holds it. A lock whose process is gone, or that
 * is older than two hours, is taken over.
 */
export async function withLock(directory, name, work, { signal, onWait } = {}) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.lock`);
  let told = false;
  for (;;) {
    if (signal?.aborted) throw new Cancelled();
    try {
      await writeFile(file, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (await stale(file)) {
      await rm(file, { force: true });
      continue;
    }
    if (!told) {
      told = true;
      onWait?.();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  try {
    return await work();
  } finally {
    await rm(file, { force: true });
  }
}

async function stale(file) {
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  } catch (error) {
    // Let go meanwhile: try again.
    return error.code === "ENOENT";
  }
}

async function npmEntry() {
  const directories = [
    path.dirname(process.execPath),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ];
  for (const directory of directories) {
    for (const filename of ["node_modules/npm/bin/npm-cli.js", "npm"]) {
      try {
        const candidate = await realpath(path.join(directory, filename));
        if (candidate.endsWith(".js")) return candidate;
      } catch {}
    }
  }
  throw new Error(
    "npm is unavailable. Restart OhMyGame with its bundled Node/npm runtime.",
  );
}

/** Downloads the pinned CLI and makes the private diagnostics environment, once for every project. */
export function prepare(directory, progress, signal) {
  return withLock(directory, "prepare", () => prepareNow(directory, progress, signal), {
    signal,
    onWait: () => progress("Waiting for another project to finish preparing Maker…"),
  });
}

async function prepareNow(directory, progress, signal) {
  if (await installed(directory)) {
    try {
      await verifyDiagnostics(directory, signal);
      return;
    } catch (error) {
      if (error instanceof Cancelled) throw error;
    }
  }
  if (!(await cliInstalled(directory))) {
    progress("Preparing the Maker CLI…");
    const staging = path.join(directory, "tools-install");
    await rm(staging, { recursive: true, force: true });
    const npm = await run(
      process.execPath,
      [
        await npmEntry(),
        "install",
        "--prefix",
        staging,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `@taptap/maker@${MAKER_VERSION}`,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, signal },
    );
    if (npm.code !== 0)
      throw new Error(
        "Could not download Maker. Check your network and retry preparation.",
      );
    await rm(path.join(directory, "tools"), { recursive: true, force: true });
    await rename(staging, path.join(directory, "tools"));
  }
  progress("Preparing private Lua diagnostics…");
  let python;
  for (const [command, prefix] of [
    ["python3", []],
    ["python", []],
    ["py", ["-3"]],
  ]) {
    try {
      const result = await run(
        command,
        [
          ...prefix,
          "-c",
          "import sys; assert sys.version_info >= (3, 8); print(sys.executable)",
        ],
        { signal },
      );
      if (result.code === 0) {
        python = result.output.trim();
        break;
      }
    } catch (error) {
      if (error instanceof Cancelled) throw error;
    }
  }
  if (!python)
    throw new Error(
      "Install Python 3.8 or newer, then retry preparation. Maker diagnostics will use a private environment.",
    );
  const venv = await run(
    python,
    ["-m", "venv", path.join(directory, "python")],
    { signal },
  );
  if (venv.code !== 0)
    throw new Error(
      "Could not create Maker's private Python environment. Check that Python includes venv and pip.",
    );
  const pip = await run(
    pythonPath(directory),
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      `maker-lua-lsp==${LUA_LSP_VERSION}`,
      "watchdog==4.0.2",
    ],
    { signal },
  );
  if (pip.code !== 0)
    throw new Error(
      "Could not install Maker Lua diagnostics. Check your network and retry preparation.",
    );
  await verifyDiagnostics(directory, signal);
}

export async function verifyDiagnostics(directory, signal) {
  const result = await maker(directory, ["lua-lsp", "doctor", "--json"], {
    signal,
  });
  if (!result?.ready)
    throw new Error(
      "Prepare Maker's local environment in the TapTap Maker panel first.",
    );
}
