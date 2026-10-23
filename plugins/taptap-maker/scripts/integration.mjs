import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { installed, maker, prepare, verifyDiagnostics } from "./runtime.mjs";

const emit = (message) =>
  process.stdout.write(JSON.stringify({ version: 1, ...message }) + "\n");
const progress = (message, authorizationUrl) =>
  emit({
    type: "progress",
    message,
    ...(authorizationUrl ? { authorizationUrl } : {}),
  });

async function binding(workspace) {
  if (!workspace) return undefined;
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

function projects(value) {
  if (!Array.isArray(value))
    throw new Error("Maker returned an invalid project list");
  return value.map((item) => ({
    id: String(item.id),
    name: String(item.name ?? item.id),
  }));
}

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

function saveInitialization(filename, state) {
  writeFileSync(`${filename}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${filename}.tmp`, filename);
}

async function initialize(directory, workspace, selection, record) {
  await mkdir(path.dirname(record.filename), { recursive: true });
  saveInitialization(record.filename, {
    projectId:
      selection[0] === "--app-id" ? selection[1] : record.state?.projectId,
  });
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
    (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.step === "app" && typeof event.data?.app_id === "string") {
        // Persist the new identity before checkout: retries must never create twice.
        saveInitialization(record.filename, { projectId: event.data.app_id });
        progress("Initializing the Maker workspace…");
      }
    },
  );
  const project = await binding(workspace);
  if (!project)
    throw new Error("Maker initialization did not bind the workspace");
  saveInitialization(record.filename, {
    projectId: project.id,
    completed: true,
  });
  return status(directory, workspace);
}

async function status(directory, workspace) {
  let project = await binding(workspace);
  const pending = workspace
    ? (await initialization(directory, workspace)).state
    : undefined;
  if (pending && !pending.completed) project = null;
  const result = (status) => ({
    connection: { status },
    ...(workspace ? { project } : {}),
  });
  if (!(await installed(directory))) return result("needs-setup");
  try {
    await verifyDiagnostics(directory);
  } catch {
    return result("needs-setup");
  }
  try {
    await maker(directory, ["apps", "--json"]);
    return result("ready");
  } catch (cause) {
    if (/authorization is missing/.test(cause.message))
      return result("needs-auth");
    throw cause;
  }
}

function previewResult(value, logs = false) {
  const missing = value.install_state !== "ready" && !value.executable;
  return {
    preview: {
      status: value.process_alive
        ? "running"
        : missing
          ? "missing"
          : value.state === "failed"
            ? "error"
            : "stopped",
      ...(value.error ? { message: String(value.error).slice(0, 4096) } : {}),
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
    },
  };
}

async function main(request) {
  if (request.version !== 1 || !path.isAbsolute(request.dataDirectory))
    throw new Error("Unsupported plugin integration request");
  const {
    action,
    dataDirectory: directory,
    workspacePath: workspace,
  } = request;
  if (action === "prepare") {
    await prepare(directory, progress);
    return status(directory, workspace);
  }
  if (action === "status") return status(directory, workspace);
  if (!(await installed(directory)))
    throw new Error("Prepare the Maker environment in Plugins first");
  if (action === "connect") {
    await maker(directory, ["login", "--json"], (line) => {
      try {
        const event = JSON.parse(line);
        const url = /https:\/\/[^\s]+/.exec(event.message ?? "")?.[0];
        if (url) progress("Complete Maker authorization in your browser.", url);
      } catch {}
    });
    return status(directory, workspace);
  }
  if (action === "projects")
    return { projects: projects(await maker(directory, ["apps", "--json"])) };
  if (!workspace || !path.isAbsolute(workspace))
    throw new Error("Select a local project workspace first");
  if (action === "create") {
    const current = await binding(workspace);
    const record = await initialization(directory, workspace);
    if (current && (!record.state || record.state.completed))
      return status(directory, workspace);
    const remoteId = current?.id ?? record.state?.projectId;
    if (record.state && !remoteId)
      throw new Error(
        "Project creation outcome is unknown. Refresh the project list and connect the created project instead of creating another one.",
      );
    if (!remoteId && (await readdir(workspace)).length)
      throw new Error(
        "Choose an empty directory or import an existing Maker workspace",
      );
    if (!request.projectName?.trim()) throw new Error("Enter a project name");
    await verifyDiagnostics(directory);
    progress(
      remoteId
        ? "Resuming Maker project initialization…"
        : "Creating a new Maker project…",
    );
    return initialize(
      directory,
      workspace,
      remoteId
        ? ["--app-id", remoteId]
        : ["--create", "--name", request.projectName.trim()],
      record,
    );
  }
  if (action === "bind") {
    if (!request.projectId) throw new Error("Select a Maker project first");
    const current = await binding(workspace);
    const record = await initialization(directory, workspace);
    if (current) {
      if (current.id !== request.projectId)
        throw new Error(
          "This directory is already bound to another Maker project",
        );
      if (!record.state || record.state.completed)
        return status(directory, workspace);
      await verifyDiagnostics(directory);
      return initialize(directory, workspace, ["--app-id", current.id], record);
    }
    if ((await readdir(workspace)).length)
      throw new Error(
        "Choose an empty directory or import an existing Maker workspace",
      );
    await verifyDiagnostics(directory); // Prevent init's multi-editor LSP installer.
    const available = projects(await maker(directory, ["apps", "--json"]));
    if (!available.some((item) => item.id === request.projectId))
      throw new Error("Selected Maker project is unavailable to this account");
    progress("Connecting the selected Maker project…");
    return initialize(
      directory,
      workspace,
      ["--app-id", request.projectId],
      record,
    );
  }
  if (action.startsWith("preview-")) {
    if (!(await binding(workspace)))
      throw new Error("Connect a Maker project before previewing it");
    const command = action.slice("preview-".length);
    if (
      !["status", "install", "start", "refresh", "stop", "logs"].includes(
        command,
      )
    )
      throw new Error("Unsupported preview action");
    const value = await maker(directory, [
      "preview",
      command,
      "--target-dir",
      workspace,
      ...(command === "logs" ? ["--tail", "--limit", "100"] : []),
      "--json",
    ]);
    // Mutation responses vary in shape. Status is the authoritative runtime
    // identity; the host never guesses PIDs or kills an external game window.
    if (["status", "logs"].includes(command))
      return previewResult(value, command === "logs");
    return previewResult(
      await maker(directory, [
        "preview",
        "status",
        "--target-dir",
        workspace,
        "--json",
      ]),
    );
  }
  throw new Error("Unsupported plugin action");
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 64 * 1024) throw new Error("Plugin request is too large");
}
try {
  emit({ type: "result", result: await main(JSON.parse(input)) });
} catch (cause) {
  emit({
    type: "error",
    message: String(cause.message ?? cause).slice(0, 4096),
  });
  process.exitCode = 1;
}
