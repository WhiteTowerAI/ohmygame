import { randomUUID } from "node:crypto";

/** System proxy detection belongs to Electron; the daemon asks over private child IPC. */
export function requestSystemProxy(): Promise<string> {
  if (!process.connected || !process.send)
    return Promise.reject(
      new Error("System proxy detection requires the desktop app"),
    );
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: string) => {
      clearTimeout(timeout);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve(result ?? "DIRECT");
    };
    const onMessage = (value: unknown) => {
      const message = value as {
        channel?: string;
        id?: string;
        result?: string;
        error?: string;
      } | null;
      if (
        message?.channel !== "ohmygame:system-proxy:result" ||
        message.id !== id
      )
        return;
      if (message.error) finish(new Error(message.error));
      else if (typeof message.result === "string")
        finish(undefined, message.result);
    };
    const onDisconnect = () =>
      finish(new Error("The desktop proxy service disconnected"));
    const timeout = setTimeout(
      () => finish(new Error("System proxy detection timed out")),
      10_000,
    );
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send!({ channel: "ohmygame:system-proxy:resolve", id }, (error) => {
      if (error) finish(error);
    });
  });
}
