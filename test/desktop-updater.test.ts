import { beforeEach, expect, it, vi } from "vitest";
const updater = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(), appListeners: new Map<string, () => void>(),
  checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), quit: vi.fn(),
}));
vi.mock("electron", () => ({ app: {
  isPackaged: true, once: (name: string, listener: () => void) => updater.appListeners.set(name, listener), quit: updater.quit,
} }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {
  on: (name: string, fn: (...args: any[]) => void) => updater.listeners.set(name, fn),
  checkForUpdates: updater.checkForUpdates, downloadUpdate: updater.downloadUpdate, quitAndInstall: updater.quitAndInstall,
} } }));
import { DesktopUpdater } from "../src/desktop/updater.js";

beforeEach(() => vi.clearAllMocks());

it("prepares and launches a downloaded update once despite repeated clicks", async () => {
  let finish!: () => void;
  const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const desktop = new DesktopUpdater("1.0.0", cleanup);
  updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
  const first = desktop.install();
  await desktop.install();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  finish(); await first;
  if (process.platform === "win32") {
    expect(updater.quit).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    updater.appListeners.get("will-quit")!();
  }
  await desktop.install();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false);
});

it("retries an interrupted download without requiring another update check", async () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-available")!({ version: "1.1.0" });
  updater.downloadUpdate.mockRejectedValueOnce(new Error("read ECONNRESET"));

  await desktop.download();
  expect(desktop.state().status).toMatchObject({
    type: "error", phase: "download", code: "network", retry: "download", version: "1.1.0",
  });

  updater.downloadUpdate.mockResolvedValueOnce(undefined);
  await desktop.download();
  expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
});
