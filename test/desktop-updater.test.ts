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

it("preserves version-bound notes through download, failure, retry and installation", async () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-available")!({ version: "1.1.0", releaseNotes: "### Fixed\n\n- Restore previews." });
  const release = { version: "1.1.0", notes: "### Fixed\n\n- Restore previews." };
  expect(desktop.state().availableRelease).toEqual(release);
  updater.listeners.get("download-progress")!({ percent: 50 });
  expect(desktop.state().availableRelease).toEqual(release);
  updater.listeners.get("error")!(new Error("ECONNRESET"));
  expect(desktop.state().availableRelease).toEqual(release);
  updater.downloadUpdate.mockResolvedValueOnce(undefined);
  await desktop.download();
  updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
  expect(desktop.state().availableRelease).toEqual(release);
  await desktop.install();
  expect(desktop.state().availableRelease).toEqual(release);
});

it("uses only the target version's notes and clears stale notes on subsequent checks", () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-available")!({ version: "1.2.0", releaseNotes: [
    { version: "1.1.0", note: "Earlier update." },
    { version: "1.2.0", note: "Latest update." },
  ] });
  expect(desktop.state().availableRelease).toEqual({ version: "1.2.0", notes: "Latest update." });
  updater.listeners.get("update-available")!({ version: "1.3.0" });
  expect(desktop.state().availableRelease).toEqual({ version: "1.3.0", notes: "" });
  updater.listeners.get("update-not-available")!();
  expect(desktop.state().availableRelease).toBeUndefined();
});

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

it("skips a scheduled check that would discard a discovered release", async () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-available")!({ version: "1.1.0" });

  expect(await desktop.check(true)).toBe("skipped");
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  expect(desktop.state().status).toEqual({ type: "available", version: "1.1.0" });

  updater.checkForUpdates.mockResolvedValueOnce(undefined);
  expect(await desktop.check()).toBe("checked");
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
});

it("reports automatic failures without exposing them in the visible state", async () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-not-available")!();
  const states = vi.fn();
  desktop.subscribe(states);
  updater.checkForUpdates.mockImplementationOnce(async () => {
    updater.listeners.get("checking-for-update")!();
    const error = new Error("getaddrinfo ENOTFOUND updates.ohmygame.ai");
    updater.listeners.get("error")!(error);
    throw error;
  });

  expect(await desktop.check(true)).toBe("failed");
  expect(desktop.state().status).toEqual({ type: "up-to-date" });
  expect(states).not.toHaveBeenCalled();

  updater.checkForUpdates.mockImplementationOnce(async () => {
    updater.listeners.get("update-not-available")!();
  });
  expect(await desktop.check(true)).toBe("checked");
  expect(desktop.state().status).toEqual({ type: "up-to-date" });
});

it("surfaces a failed manual check so the user can retry it", async () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.checkForUpdates.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND updates.ohmygame.ai"));

  expect(await desktop.check()).toBe("failed");
  expect(desktop.state().status).toMatchObject({
    type: "error", phase: "check", code: "network", retry: "check",
  });
});
