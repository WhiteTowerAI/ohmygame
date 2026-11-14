import { fork } from "node:child_process";
import path from "node:path";
import { expect } from "vitest";

export async function killAt(
  directory: string,
  action: "resume" | "rollback" | "startup" | "commit" | "activate",
  boundary: string,
  vendor: "minimax" | "seedance" = "minimax",
) {
  const child = fork(
    path.resolve("test/fixtures/media-settings-transaction-worker.cjs"),
    [directory, action, boundary, vendor],
    {
      execPath: "node",
      execArgv: ["--conditions=ohmygame-source", "--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8000);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  let reached = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Worker did not reach checkpoint")),
        10_000,
      );
      child.once("message", (message) => {
        clearTimeout(timeout);
        if ((message as { checkpoint?: string }).checkpoint === boundary)
          resolve();
        else
          reject(
            new Error(
              `Unexpected worker checkpoint: ${JSON.stringify(message)}`,
            ),
          );
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Worker exited before checkpoint: ${boundary} (code ${code}, signal ${signal})\n${stderr}`,
          ),
        );
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    reached = true;
  } finally {
    child.kill("SIGKILL");
    const code = await exited;
    if (reached) expect(code).not.toBe(0);
  }
}
