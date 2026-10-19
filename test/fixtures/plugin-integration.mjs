import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
await appendFile(
  path.join(request.dataDirectory, "actions.log"),
  `${request.action}\n`,
);
const emit = (message) =>
  process.stdout.write(JSON.stringify({ version: 1, ...message }) + "\n");
if (request.action === "connect") {
  emit({
    type: "progress",
    message: "Waiting for browser",
    authorizationUrl: "https://example.com/authorize",
  });
  setInterval(() => {}, 1000);
} else if (request.action === "prepare") {
  emit({ type: "progress", message: "Preparing" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  emit({ type: "result", result: { connection: { status: "ready" } } });
} else if (request.action === "bind" || request.action === "create") {
  const projectId =
    request.action === "create" ? request.projectName : request.projectId;
  await mkdir(path.join(request.workspacePath, ".fixture"), {
    recursive: true,
  });
  await writeFile(
    path.join(request.workspacePath, ".fixture/project.json"),
    JSON.stringify({ id: projectId }),
  );
  emit({
    type: "result",
    result: {
      project: { id: projectId },
      connection: { status: "ready" },
    },
  });
} else if (request.action === "preview-start") {
  emit({ type: "result", result: { preview: { status: "running" } } });
} else if (request.action === "preview-logs") {
  process.stdout.write('{"version":2,"type":"result","result":{}}\n');
} else if (request.action === "preview-refresh") {
  process.stdout.write("x".repeat(300000));
} else if (request.action === "preview-stop") {
  emit({
    type: "progress",
    message: "bad URL",
    authorizationUrl: "file:///etc/passwd",
  });
} else {
  let project = null;
  if (request.workspacePath) {
    try {
      project = JSON.parse(
        await (
          await import("node:fs/promises")
        ).readFile(
          path.join(request.workspacePath, ".fixture/project.json"),
          "utf8",
        ),
      );
    } catch {}
  }
  emit({
    type: "result",
    result: {
      connection: {
        status: existsSync(path.join(request.dataDirectory, "signed-out"))
          ? "needs-auth"
          : "ready",
      },
      ...(request.workspacePath ? { project } : {}),
    },
  });
}
