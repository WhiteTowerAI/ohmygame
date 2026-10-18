import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
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

export async function run(
  command,
  args,
  { env = process.env, cwd, onLine } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let pending = "";
    let failure;
    let diagnostic = "";
    let authorizationMissing = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
        failure = new Error("Maker output exceeded its limit");
        child.kill();
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
    // Upstream stderr can include credentials. Only protocol messages below
    // reach the UI; never forward arbitrary CLI output into a conversation.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-8192);
      authorizationMissing ||= AUTHORIZATION_MISSING.test(diagnostic);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (onLine && pending.trim()) onLine(pending);
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

export async function installed(directory) {
  if (!(await cliInstalled(directory))) return false;
  try {
    await access(pythonPath(directory));
    return true;
  } catch {
    return false;
  }
}

export async function maker(directory, args, onLine) {
  const result = await run(process.execPath, [makerPath(directory), ...args], {
    env: makerEnvironment(directory),
    onLine,
  });
  if (result.code !== 0) {
    // Known recovery categories are useful; raw upstream errors can contain a
    // token-bearing Git URL or account credentials and stay out of the UI.
    if (
      result.authorizationMissing ||
      AUTHORIZATION_MISSING.test(result.output)
    )
      throw new Error(
        "Maker authorization is missing or expired. Connect your account again.",
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

export async function prepare(directory, progress) {
  await mkdir(directory, { recursive: true });
  if (await installed(directory)) {
    try {
      await verifyDiagnostics(directory);
      return;
    } catch {}
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
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
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
      const result = await run(command, [
        ...prefix,
        "-c",
        "import sys; assert sys.version_info >= (3, 8); print(sys.executable)",
      ]);
      if (result.code === 0) {
        python = result.output.trim();
        break;
      }
    } catch {}
  }
  if (!python)
    throw new Error(
      "Install Python 3.8 or newer, then retry preparation. Maker diagnostics will use a private environment.",
    );
  const venv = await run(python, [
    "-m",
    "venv",
    path.join(directory, "python"),
  ]);
  if (venv.code !== 0)
    throw new Error(
      "Could not create Maker's private Python environment. Check that Python includes venv and pip.",
    );
  const pip = await run(pythonPath(directory), [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    `maker-lua-lsp==${LUA_LSP_VERSION}`,
    "watchdog==4.0.2",
  ]);
  if (pip.code !== 0)
    throw new Error(
      "Could not install Maker Lua diagnostics. Check your network and retry preparation.",
    );
  await verifyDiagnostics(directory);
}

export async function verifyDiagnostics(directory) {
  const result = await maker(directory, ["lua-lsp", "doctor", "--json"]);
  if (!result?.ready)
    throw new Error(
      "Prepare Maker's local environment before connecting a project.",
    );
}
