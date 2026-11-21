import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EXTERNAL_MCP_DISABLED_ENV } from "../shared/external-mcp.js";
import { windowsMcpUpdatePaused } from "./external-mcp-update.js";
import {
  appStartCommand,
  ExternalMcpLauncher,
  type Message,
} from "./external-mcp-launcher.js";

/**
 * The `ohmygame-mcp` command: the app's executable runs this as Node
 * (`ELECTRON_RUN_AS_NODE=1`) with `--data-dir`, and in development `--app`.
 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.env[EXTERNAL_MCP_DISABLED_ENV] === "1") {
    process.stderr.write(
      "OhMyGame runs this agent itself and already gives it OhMyGame's tools.\n",
    );
    process.exit(1);
  }
  const dataDirectory = argument("--data-dir");
  if (!dataDirectory) {
    process.stderr.write(
      "Usage: ohmygame-mcp --data-dir <OhMyGame data folder>\n",
    );
    process.exit(2);
  }
  const windows = process.platform === "win32";
  const updatePaused = () => windowsMcpUpdatePaused(dataDirectory).catch(() => false);
  if (windows && await updatePaused()) process.exit(0);
  const appPath = argument("--app");
  const launcher = new ExternalMcpLauncher({
    dataDirectory,
    write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    startApp: () => {
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      // The app's executable is the one running this script as Node.
      const { command, args } = appStartCommand(process.execPath, appPath);
      spawn(command, args, {
        detached: true,
        stdio: "ignore",
        env: environment,
      }).unref();
    },
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let draining = false;
  const poll = windows ? setInterval(() => {
    void updatePaused().then((paused) => {
      if (!paused || draining) return;
      draining = true;
      if (!pending) lines.close();
    });
  }, 250) : undefined;
  poll?.unref();
  lines.on("line", (line) => {
    if (!line.trim() || draining) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    pending++;
    void launcher.receive(message).finally(() => {
      pending--;
      if (draining && !pending) lines.close();
    });
  });
  lines.once("close", () => {
    clearInterval(poll);
    void launcher.close().finally(() => process.exit(0));
  });
}

void main();
