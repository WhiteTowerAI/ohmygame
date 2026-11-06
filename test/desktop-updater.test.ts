import { beforeEach, expect, it, vi } from "vitest";
const updater = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(), appListeners: new Map<string, () => void>(),
  native: new Map<string, (...args: any[]) => void>(),
  checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), quit: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, once: (name: string, listener: () => void) => updater.appListeners.set(name, listener), quit: updater.quit },
  autoUpdater: { on: (name: string, listener: (...args: any[]) => void) => updater.native.set(name, listener) },
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {
  on: (name: string, fn: (...args: any[]) => void) => updater.listeners.set(name, fn),
  checkForUpdates: updater.checkForUpdates, downloadUpdate: updater.downloadUpdate, quitAndInstall: updater.quitAndInstall,
} } }));
import { DesktopUpdater } from "../src/desktop/updater.js";

beforeEach(() => vi.clearAllMocks());

async function onPlatform(platform: NodeJS.Platform, run: () => Promise<void> | void): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

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

it("replaces a found release with a newer one and keeps the same one as it is", async () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-available")!({ version: "1.1.0" });
  const states = vi.fn();
  desktop.subscribe(states);

  updater.checkForUpdates.mockImplementationOnce(async () => {
    updater.listeners.get("checking-for-update")!();
    updater.listeners.get("update-available")!({ version: "1.2.0", releaseNotes: "Newer." });
  });
  expect(await desktop.check(true)).toBe("checked");
  expect(desktop.state().status).toEqual({ type: "available", version: "1.2.0" });
  expect(desktop.state().availableRelease).toEqual({ version: "1.2.0", notes: "Newer." });
  expect(states.mock.calls.map(([state]) => state.status.type)).toEqual(["available"]);

  updater.listeners.get("update-downloaded")!({ version: "1.2.0" });
  updater.checkForUpdates.mockImplementationOnce(async () => {
    updater.listeners.get("update-available")!({ version: "1.2.0" });
  });
  expect(await desktop.check(true)).toBe("checked");
  expect(desktop.state().status).toEqual({ type: "ready", version: "1.2.0" });

  updater.checkForUpdates.mockImplementationOnce(async () => {
    updater.listeners.get("update-available")!({ version: "1.3.0" });
  });
  expect(await desktop.check(true)).toBe("checked");
  expect(desktop.state().status).toEqual({ type: "available", version: "1.3.0" });
});

it("leaves a transfer or installation alone, even when a check overlaps it", async () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-available")!({ version: "1.1.0" });
  let finish!: () => void;
  updater.downloadUpdate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const download = desktop.download();
  await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());

  expect(await desktop.check(true)).toBe("skipped");
  expect(await desktop.check()).toBe("skipped");
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  updater.listeners.get("update-available")!({ version: "1.2.0" });
  updater.listeners.get("download-progress")!({ percent: 40 });
  expect(desktop.state().status).toEqual({ type: "downloading", version: "1.1.0", percent: 40 });
  finish(); await download;
  updater.listeners.get("update-downloaded")!({ version: "1.1.0" });

  let save!: () => void;
  const installing = new DesktopUpdater("1.0.0", () => new Promise<void>(resolve => { save = resolve; }));
  updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
  const install = installing.install();
  updater.listeners.get("update-available")!({ version: "1.2.0" });
  updater.listeners.get("update-not-available")!();
  expect(installing.state().status).toEqual({ type: "installing", version: "1.1.0" });
  save(); await install;
});

it("keeps installing when a check that started before it fails, and still reports other failures", async () => {
  let save!: () => void;
  const desktop = new DesktopUpdater("1.0.0", () => new Promise<void>(resolve => { save = resolve; }));
  updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
  let fail!: () => void;
  updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
    fail = () => {
      const error = new Error("getaddrinfo ENOTFOUND updates.ohmygame.ai");
      updater.listeners.get("error")!(error);
      reject(error);
    };
  }));
  const check = desktop.check(true);
  const install = desktop.install();
  save(); await install;
  fail();
  expect(await check).toBe("failed");
  expect(desktop.state().status).toEqual({ type: "installing", version: "1.1.0" });
  await desktop.install();
  expect(updater.quitAndInstall.mock.calls.length + updater.quit.mock.calls.length).toBe(1);

  // An installer failure during a check is not the check's, so it shows once the check ends.
  const next = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
  let finish!: () => void;
  updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const nextCheck = next.check(true);
  await next.install();
  updater.listeners.get("error")!(new Error("installer exited with code 2"));
  expect(next.state().status).toEqual({ type: "installing", version: "1.1.0" });
  finish();
  expect(await nextCheck).toBe("checked");
  expect(next.state().status).toMatchObject({ type: "error", phase: "install", retry: "install", version: "1.1.0" });
});

it("keeps a release handed to Squirrel.Mac for quit, since a newer download could not replace it", async () => {
  await onPlatform("darwin", async () => {
    const desktop = new DesktopUpdater("1.0.0", vi.fn());
    desktop.setAutomatic(true);
    updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
    // Staging and staged both keep it.
    expect(await desktop.check(true)).toBe("skipped");
    updater.native.get("update-downloaded")!();
    desktop.setAutomatic(false);
    expect(await desktop.check(true)).toBe("skipped");
    expect(await desktop.check()).toBe("skipped");
    updater.listeners.get("update-available")!({ version: "1.2.0" });
    expect(desktop.state().status).toEqual({ type: "ready", version: "1.1.0" });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    // A failed handoff fails the download and releases it for a retry.
    const failed = new DesktopUpdater("1.0.0", vi.fn());
    failed.setAutomatic(true);
    updater.listeners.get("update-available")!({ version: "1.1.0" });
    const staging = new Error("Squirrel could not stage the update");
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
      updater.listeners.get("error")!(staging);
      updater.native.get("error")!(staging);
      throw staging;
    });
    await vi.waitFor(() => expect(failed.state().status).toMatchObject({ type: "error", retry: "download", version: "1.1.0" }));
    updater.downloadUpdate.mockResolvedValueOnce(undefined);
    await failed.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);

    // A later download step failing, such as caching the blockmap, leaves the handed-off release ready.
    const cached = new DesktopUpdater("1.0.0", vi.fn());
    cached.setAutomatic(true);
    updater.listeners.get("update-available")!({ version: "1.1.0" });
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
      const error = new Error("ENOSPC: no space left on device, copyfile current.blockmap");
      updater.listeners.get("error")!(error);
      throw error;
    });
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(cached.state().status).toEqual({ type: "ready", version: "1.1.0" });
    updater.native.get("update-downloaded")!();
    expect(await cached.check(true)).toBe("skipped");

    // Without install on quit nothing is staged, so a newer release still replaces it.
    const manual = new DesktopUpdater("1.0.0", vi.fn());
    updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
    updater.listeners.get("update-available")!({ version: "1.2.0" });
    expect(manual.state().status).toEqual({ type: "available", version: "1.2.0" });
  });
});

it("checks a release found a while ago again before downloading it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const desktop = new DesktopUpdater("1.0.0", vi.fn());
    updater.listeners.get("update-available")!({ version: "1.1.0" });
    vi.advanceTimersByTime(31 * 60_000);
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.listeners.get("checking-for-update")!();
      updater.listeners.get("update-available")!({ version: "1.2.0" });
    });
    let downloading: unknown;
    updater.downloadUpdate.mockImplementationOnce(async () => { downloading = desktop.state().status; });
    await desktop.download();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(downloading).toEqual({ type: "available", version: "1.2.0" });

    // A failed look keeps the release already found and stays out of sight.
    vi.advanceTimersByTime(31 * 60_000);
    const states = vi.fn();
    desktop.subscribe(states);
    updater.checkForUpdates.mockImplementationOnce(async () => {
      const error = new Error("getaddrinfo ENOTFOUND updates.ohmygame.ai");
      updater.listeners.get("error")!(error);
      throw error;
    });
    await desktop.download();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(states).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("does not download a stale release when a check reports no update", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const desktop = new DesktopUpdater("1.0.0", vi.fn());
    updater.listeners.get("update-available")!({ version: "1.1.0" });
    vi.advanceTimersByTime(31 * 60_000);
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.listeners.get("update-not-available")!();
    });
    await desktop.download();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(desktop.state().status).toEqual({ type: "up-to-date" });
  } finally {
    vi.useRealTimers();
  }
});

it("waits for a running check before downloading, and starts one download for repeated clicks", async () => {
  const desktop = new DesktopUpdater("1.0.0", vi.fn());
  updater.listeners.get("update-available")!({ version: "1.1.0" });
  let found!: () => void;
  updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>(resolve => {
    found = () => { updater.listeners.get("update-available")!({ version: "1.2.0" }); resolve(); };
  }));
  const check = desktop.check(true);
  const first = desktop.download();
  const second = desktop.download();
  await Promise.resolve();
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  found();
  await Promise.all([check, first, second]);
  expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  expect(desktop.state().availableRelease?.version).toBe("1.2.0");
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

it("downloads found releases by itself and installs them on quit when updates are automatic", async () => {
  // Windows behaviour; on macOS a release staged with Squirrel.Mac is kept instead.
  await onPlatform("win32", async () => {
    const { default: { autoUpdater } } = await import("electron-updater");
    const desktop = new DesktopUpdater("1.0.0", vi.fn());
    updater.downloadUpdate.mockResolvedValue(undefined);
    updater.listeners.get("update-available")!({ version: "1.1.0" });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    desktop.setAutomatic(true);
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
    updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
    updater.listeners.get("update-available")!({ version: "1.2.0" });
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledTimes(2));
    updater.listeners.get("update-downloaded")!({ version: "1.2.0" });
    desktop.setAutomatic(false);
    updater.listeners.get("update-available")!({ version: "1.3.0" });
    await Promise.resolve();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });
});

it("installs on quit only while a complete download is waiting", async () => {
  // Windows behaviour; on macOS a release staged with Squirrel.Mac is kept instead.
  await onPlatform("win32", async () => {
    const { default: { autoUpdater } } = await import("electron-updater");
    const desktop = new DesktopUpdater("1.0.0", vi.fn());
    desktop.setAutomatic(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

    // Downloading 1.2.0 clears the pending 1.1.0 installer, so quitting meanwhile installs nothing.
    updater.listeners.get("update-available")!({ version: "1.2.0" });
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    updater.listeners.get("download-progress")!({ percent: 50 });
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    updater.listeners.get("update-downloaded")!({ version: "1.2.0" });
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

    desktop.setAutomatic(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });
});
