import { spawn, type ChildProcess } from "node:child_process";

/** Only the desktop's own daemon can register process groups for crash cleanup. */
export function registerProjectProcess(child: ChildProcess): void {
  if (process.env.OHMYGAME_PROJECT_PROCESS_IPC !== "1" || !process.connected)
    return;
  const send = (action: "started" | "stopped") => {
    if (child.pid && process.connected)
      process.send?.(
        { channel: "ohmygame:project-process", action, pid: child.pid },
        () => {},
      );
  };
  child.once("spawn", () => send("started"));
  child.once("close", () => send("stopped"));
}

/** False only when Windows rejected the request without reporting a successful signal. */
export async function signalProcessTree(
  pid: number,
  force: boolean,
): Promise<boolean> {
  if (process.platform === "win32") {
    return new Promise<boolean>((resolve, reject) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      // Rejected console processes produce code 128 and errors on stderr.
      // /T can also report success on stdout for other descendants.
      let reportedSuccess = false;
      killer.stdout.on("data", () => {
        reportedSuccess = true;
      });
      killer.once("error", reject);
      killer.once("close", (code) => resolve(code !== 128 || reportedSuccess));
    });
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return true;
}

export async function terminateProjectProcess(
  child: ChildProcess,
): Promise<void> {
  if (!child.pid) return; // A failed spawn emits close, but never exit.
  // Even when the group leader exited, its descendants may still be running.
  if (child.exitCode !== null || child.signalCode !== null) {
    await signalProcessTree(child.pid, true);
    return;
  }
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const requested = await signalProcessTree(child.pid, false);
  const closedGracefully = requested && (await waitForClose(closed, 3_000));
  // close only describes the leader and its streams, not every descendant.
  await signalProcessTree(child.pid, true);
  if (!closedGracefully) await waitForClose(closed, 500);
}

async function waitForClose(
  closed: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
