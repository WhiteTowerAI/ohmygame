import { readFile, readdir, realpath } from "node:fs/promises";
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

async function status(directory, workspace) {
  const project = await binding(workspace);
  if (!(await installed(directory)))
    return {
      connection: { status: "needs-setup" },
      ...(workspace ? { project } : {}),
    };
  try {
    await verifyDiagnostics(directory);
  } catch {
    return {
      connection: { status: "needs-setup" },
      ...(workspace ? { project } : {}),
    };
  }
  try {
    await maker(directory, ["apps", "--json"]);
    return {
      connection: { status: "ready" },
      ...(workspace ? { project } : {}),
    };
  } catch (cause) {
    if (/authorization is missing/.test(cause.message))
      return {
        connection: { status: "needs-auth" },
        ...(workspace ? { project } : {}),
      };
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
  if (action === "bind") {
    if (!request.projectId) throw new Error("Select a Maker project first");
    await verifyDiagnostics(directory); // Prevent init's multi-editor LSP installer.
    const current = await binding(workspace);
    if (current && current.id !== request.projectId)
      throw new Error(
        "This directory is already bound to another Maker project",
      );
    if (!current && (await readdir(workspace)).length)
      throw new Error(
        "Choose an empty directory or import an existing Maker workspace",
      );
    const available = projects(await maker(directory, ["apps", "--json"]));
    if (!available.some((item) => item.id === request.projectId))
      throw new Error("Selected Maker project is unavailable to this account");
    progress("Connecting the selected Maker project…");
    await maker(directory, [
      "init",
      "--app-id",
      request.projectId,
      "--target-dir",
      workspace,
      "--skip-mcp-install",
      "--skip-confirm",
      "--json",
    ]);
    return status(directory, workspace);
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
