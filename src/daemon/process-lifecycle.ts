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

export async function signalProcessTree(
  pid: number,
  force: boolean,
): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", reject);
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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
  await signalProcessTree(child.pid, false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), 3_000);
    }),
  ]);
  clearTimeout(timer);
  // close only describes the leader and its streams, not every descendant.
  await signalProcessTree(child.pid, true);
  if (timedOut) {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  }
}
