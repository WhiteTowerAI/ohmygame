// What the TapTap Maker panel and tools do, on top of the Maker CLI. Each
// function takes the call's context: the plugin's data folder, the project's
// folder, the call's signal and its progress.
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  installed,
  maker,
  prepare as prepareMaker,
  redact,
  verifyDiagnostics,
} from "./runtime.mjs";

/**
 * What OhMyGame keeps in a project, which Maker's builds must not commit:
 * Maker stages everything Git doesn't ignore.
 */
const APP_FILES = ["/ohmygame.json", "/.ohmygame/", "/canvas/"];

/** The Maker project the folder is bound to, from `.maker-mcp/config.json`; null when unbound. */
export async function binding(workspace) {
  try {
    const filename = await realpath(
      path.join(workspace, ".maker-mcp/config.json"),
    );
    const root = await realpath(workspace);
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Maker binding must stay inside the workspace");
    const value = JSON.parse(await readFile(filename, "utf8"));
    if (typeof value.project_id !== "string" || !value.project_id.trim())
      throw new Error("Maker project binding is invalid");
    return { id: value.project_id };
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    throw cause;
  }
}

function projectList(value) {
  if (!Array.isArray(value))
    throw new Error("Maker returned an invalid project list");
  return value.map((item) => ({
    id: String(item.id),
    name: String(item.name ?? item.id),
  }));
}

/**
 * The record of a create or bind for this folder. It keeps the remote id
 * before checkout, so a retry never creates a second Maker project.
 */
async function initialization(directory, workspace) {
  const key = createHash("sha256")
    .update(await realpath(workspace))
    .digest("hex");
  const filename = path.join(directory, "initializations", `${key}.json`);
  try {
    return { filename, state: JSON.parse(await readFile(filename, "utf8")) };
  } catch (cause) {
    if (cause.code === "ENOENT") return { filename };
    throw cause;
  }
}

async function saveInitialization(filename, state) {
  await writeFile(`${filename}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${filename}.tmp`, filename);
}

const exists = (filename) =>
  stat(filename).then(
    () => true,
    () => false,
  );

/**
 * Maker sets up its repository in the folder, keeping the files already
 * there unless the Maker project has files at the same paths. A folder that
 * is already some other Git repository is refused: Maker would replace its
 * `origin` and its branch.
 */
async function assertNotARepository(workspace) {
  if (await exists(path.join(workspace, ".git")))
    throw new Error(
      "This project's folder is already a Git repository. Maker would replace its remote and branch, so connect Maker from a folder that isn't one.",
    );
}

/**
 * The repository's `info/exclude`. A worktree or submodule has a `.git` file
 * naming its Git folder, and a worktree shares the main repository's
 * `info/`, which its Git folder's `commondir` names.
 */
async function excludeFile(workspace) {
  const dotGit = path.join(workspace, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return null;
  let gitDirectory = dotGit;
  if (info.isFile()) {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
    if (!pointer) return null;
    gitDirectory = path.resolve(workspace, pointer[1]);
    const common = await readFile(path.join(gitDirectory, "commondir"), "utf8").catch(() => "");
    if (common.trim()) gitDirectory = path.resolve(gitDirectory, common.trim());
  } else if (!info.isDirectory()) return null;
  return path.join(gitDirectory, "info", "exclude");
}

/** Keeps OhMyGame's own files out of Maker's commits; adds only what is missing. */
async function excludeAppFiles(workspace) {
  const filename = await excludeFile(workspace);
  if (!filename) return;
  const current = await readFile(filename, "utf8").catch((cause) => {
    if (cause.code === "ENOENT") return "";
    throw cause;
  });
  // Git ignores trailing spaces in a pattern, but leading ones are part of it.
  const lines = new Set(current.split(/\r?\n/).map((line) => line.replace(/\s+$/, "")));
  const missing = APP_FILES.filter((entry) => !lines.has(entry));
  if (!missing.length) return;
  await mkdir(path.dirname(filename), { recursive: true });
  await appendFile(
    filename,
    `${current && !current.endsWith("\n") ? "\n" : ""}# OhMyGame's own files, kept out of Maker builds\n${missing.join("\n")}\n`,
  );
}

async function initialize(context, selection, record) {
  const { directory, workspace, signal, progress } = context;
  await mkdir(path.dirname(record.filename), { recursive: true });
  await saveInitialization(record.filename, {
    // A create starts with no identity; Maker reports it before checkout.
    projectId: selection[0] === "--app-id" ? selection[1] : undefined,
  });
  let saving = Promise.resolve();
  await maker(
    directory,
    [
      "init",
      ...selection,
      "--target-dir",
      workspace,
      "--skip-mcp-install",
      "--skip-confirm",
      "--json",
    ],
    {
      signal,
      onLine: (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.step === "app" && typeof event.data?.app_id === "string") {
          // Keep the new identity before checkout: retries must never create twice.
          saving = saving.then(() =>
            saveInitialization(record.filename, {
              projectId: event.data.app_id,
            }),
          );
          progress("Initializing the Maker workspace…");
        }
      },
    },
  );
  await saving;
  const project = await binding(workspace);
  if (!project)
    throw new Error("Maker initialization did not bind the workspace");
  await excludeAppFiles(workspace);
  await saveInitialization(record.filename, {
    projectId: project.id,
    completed: true,
  });
  return status(context);
}

/** The account's state and the folder's Maker project, with its name when the account has it. */
export async function status({ directory, workspace, signal }) {
  let project = await binding(workspace);
  const pending = (await initialization(directory, workspace)).state;
  if (pending && !pending.completed) project = null;
  if (project) await excludeAppFiles(workspace);
  const result = (connection) => ({ connection, project });
  if (!(await installed(directory))) return result("needs-setup");
  try {
    await verifyDiagnostics(directory, signal);
  } catch {
    return result("needs-setup");
  }
  try {
    const available = projectList(
      await maker(directory, ["apps", "--json"], { signal }),
    );
    const name = project && available.find((item) => item.id === project.id)?.name;
    if (name && name !== project.id) project = { ...project, name };
    return result("ready");
  } catch (cause) {
    if (/authorization is missing/.test(cause.message))
      return result("needs-auth");
    throw cause;
  }
}

/**
 * Whether the agent can work here: Maker is prepared and the folder is bound.
 * Reads files only, apart from keeping OhMyGame's files out of Maker's
 * commits, since it runs before every prompt.
 */
export async function ready({ directory, workspace }) {
  if (!(await installed(directory)))
    return {
      ready: false,
      message: "Prepare TapTap Maker in its panel before sending a message.",
    };
  const record = (await initialization(directory, workspace)).state;
  if (!(await binding(workspace)) || (record && !record.completed))
    return {
      ready: false,
      message:
        "Connect this project to a Maker project in the TapTap Maker panel before sending a message.",
    };
  await excludeAppFiles(workspace);
  return { ready: true };
}

export async function prepare(context) {
  await prepareMaker(context.directory, context.progress, context.signal);
  return status(context);
}

export async function signIn(context) {
  const { directory, signal, progress } = context;
  if (!(await installed(directory)))
    throw new Error("Prepare TapTap Maker first");
  await maker(directory, ["login", "--json"], {
    signal,
    onLine: (line) => {
      try {
        const event = JSON.parse(line);
        const url = /https:\/\/[^\s]+/.exec(event.message ?? "")?.[0];
        if (url) progress("Complete Maker authorization in your browser.", url);
      } catch {}
    },
  });
  return status(context);
}

export async function projects({ directory, signal }) {
  if (!(await installed(directory)))
    throw new Error("Prepare TapTap Maker first");
  return {
    projects: projectList(await maker(directory, ["apps", "--json"], { signal })),
  };
}

/** Makes a new Maker project for this folder, or finishes one a previous try started. */
export async function create(context, { name }) {
  const { directory, workspace, signal, progress } = context;
  if (!(await installed(directory)))
    throw new Error("Prepare TapTap Maker first");
  const current = await binding(workspace);
  const record = await initialization(directory, workspace);
  if (current && (!record.state || record.state.completed))
    return status(context);
  // Only a setup that stopped partway is resumed; a finished one whose
  // binding is gone tells nothing about the folder now.
  const pending = record.state?.completed ? undefined : record.state;
  const remoteId = current?.id ?? pending?.projectId;
  if (pending && !remoteId)
    throw new Error(
      "Project creation outcome is unknown. Refresh the project list and connect the created project instead of creating another one.",
    );
  if (!remoteId) await assertNotARepository(workspace);
  if (!name?.trim()) throw new Error("Enter a project name");
  await verifyDiagnostics(directory, signal);
  progress(
    remoteId
      ? "Resuming Maker project initialization…"
      : "Creating a new Maker project…",
  );
  // Checked again just before init: the folder may have changed meanwhile.
  if (!remoteId) await assertNotARepository(workspace);
  return initialize(
    context,
    remoteId ? ["--app-id", remoteId] : ["--create", "--name", name.trim()],
    record,
  );
}

/** Binds this folder to one of the account's Maker projects. */
export async function bind(context, { projectId }) {
  const { directory, workspace, signal, progress } = context;
  if (!(await installed(directory)))
    throw new Error("Prepare TapTap Maker first");
  const current = await binding(workspace);
  const record = await initialization(directory, workspace);
  if (current) {
    if (current.id !== projectId)
      throw new Error(
        "This project is already bound to another Maker project",
      );
    if (!record.state || record.state.completed) return status(context);
    await verifyDiagnostics(directory, signal);
    return initialize(context, ["--app-id", current.id], record);
  }
  // A connect that stopped partway resumes in the repository it began.
  const resuming =
    !record.state?.completed && record.state?.projectId === projectId;
  if (!resuming) await assertNotARepository(workspace);
  await verifyDiagnostics(directory, signal); // Prevent init's multi-editor LSP installer.
  const available = projectList(
    await maker(directory, ["apps", "--json"], { signal }),
  );
  if (!available.some((item) => item.id === projectId))
    throw new Error("Selected Maker project is unavailable to this account");
  progress("Connecting the selected Maker project…");
  if (!resuming) await assertNotARepository(workspace);
  return initialize(context, ["--app-id", projectId], record);
}

/** Maker retires a preview whose window was closed; nothing failed, and it can start again. */
const RETIRED = /no longer running|stale session/i;
/** A download or connection that failed once; Maker downloads its sources on every start. */
const TRANSIENT =
  /network|download failed|remote manifest|网络|远端|ssl|tls|econnreset|etimedout|eai_again|socket hang up|timed? ?out/i;
const RETRY_DELAYS = [2000, 5000];

export const PREVIEW_ACTIONS = [
  "status",
  "install",
  "start",
  "refresh",
  "stop",
  "logs",
];

function previewResult(value, logs = false) {
  const missing = value.install_state !== "ready" && !value.executable;
  const retired =
    !value.process_alive && RETIRED.test(String(value.error ?? ""));
  return {
    status: value.process_alive
      ? "running"
      : missing
        ? "missing"
        : value.state === "failed" && !retired
          ? "error"
          : "stopped",
    ...(value.error && !retired
      ? { message: redact(value.error).slice(0, 4096) }
      : {}),
    ...(logs
      ? {
          logs: (Array.isArray(value.logs)
            ? value.logs
                .map((line) =>
                  typeof line === "string" ? line : String(line.text ?? ""),
                )
                .join("\n")
            : ""
          ).slice(-16_384),
        }
      : {}),
  };
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Maker's native preview: the game runs in its own window, outside OhMyGame. */
export async function preview(context, action) {
  const { directory, workspace, signal, progress } = context;
  if (!PREVIEW_ACTIONS.includes(action))
    throw new Error("Unsupported preview action");
  if (!(await installed(directory)))
    throw new Error("Prepare TapTap Maker first");
  if (!(await binding(workspace)))
    throw new Error("Connect a Maker project before previewing it");
  const run = (name, options) =>
    maker(
      directory,
      [
        "preview",
        name,
        "--target-dir",
        workspace,
        ...(name === "logs" ? ["--tail", "--limit", "100"] : []),
        "--json",
      ],
      { ...options, signal },
    );
  if (action === "status" || action === "logs")
    return previewResult(await run(action, { report: true }), action === "logs");
  // Mutation responses vary in shape. Status is the authoritative runtime
  // identity; the plugin never guesses PIDs or kills an external game window.
  for (let attempt = 0; ; attempt++) {
    // A refresh stops the runtime first, so after a failed one only Start brings it back.
    const name = attempt && action === "refresh" ? "start" : action;
    const failure = await run(name).then(
      () => undefined,
      (cause) => cause,
    );
    if (signal?.aborted) throw failure ?? signal.reason;
    if (/authorization/i.test(failure?.message ?? "")) throw failure;
    const value = await run("status", { report: true });
    if (!failure) return previewResult(value);
    // A retired session's error and install metadata may predate this attempt.
    const error = RETIRED.test(String(value.error ?? ""))
      ? ""
      : String(value.error ?? "");
    const retry =
      action !== "stop" &&
      attempt < RETRY_DELAYS.length &&
      (action === "install"
        ? value.install_state !== "ready"
        : TRANSIENT.test(error));
    if (!retry) {
      // The failure stands unless the status shows the work done or says why it failed.
      const done =
        action === "stop"
          ? !value.process_alive
          : action !== "install" && value.process_alive;
      if (!done && (action === "install" || !error)) throw failure;
      return previewResult(value);
    }
    progress(
      `Maker couldn't reach its servers. Retrying (${attempt + 1}/${RETRY_DELAYS.length})…`,
    );
    await wait(RETRY_DELAYS[attempt], signal);
  }
}
