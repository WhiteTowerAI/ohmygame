// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const initSentry = vi.fn();
const setCrashReports = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock("@sentry/electron/renderer", () => ({ init: initSentry }));
  localStorage.clear();
  vi.stubGlobal("ohMyGameDesktop", { setCrashReports });
});

afterEach(() => {
  vi.doUnmock("@sentry/electron/renderer");
  vi.unstubAllGlobals();
});

// Imported fresh in each test so vi.resetModules() gives the module a fresh state.
async function loadCrashReports() {
  return import("../src/renderer/crash-reports.js");
}

it("starts the renderer SDK and tells the desktop main process when usage data is on", async () => {
  const { updateCrashReporting } = await loadCrashReports();
  updateCrashReporting();
  expect(initSentry).toHaveBeenCalledOnce();
  expect(setCrashReports).toHaveBeenCalledWith(true);
});

it("sends the off choice to the desktop main process without starting the renderer SDK", async () => {
  localStorage.setItem("ohmygame:usage-data", "off");
  const { updateCrashReporting } = await loadCrashReports();
  updateCrashReporting();
  expect(initSentry).not.toHaveBeenCalled();
  expect(setCrashReports).toHaveBeenCalledWith(false);
});

it("starts the renderer SDK when usage data is turned back on, once", async () => {
  localStorage.setItem("ohmygame:usage-data", "off");
  const { updateCrashReporting } = await loadCrashReports();
  updateCrashReporting();
  expect(initSentry).not.toHaveBeenCalled();
  const { setUsageDataEnabled } = await import("../src/renderer/analytics.js");
  setUsageDataEnabled(true);
  expect(setCrashReports).toHaveBeenLastCalledWith(true);
  expect(initSentry).toHaveBeenCalledOnce();
  setUsageDataEnabled(false);
  setUsageDataEnabled(true);
  expect(initSentry).toHaveBeenCalledOnce();
});

it("starts the renderer SDK without a desktop bridge", async () => {
  vi.stubGlobal("ohMyGameDesktop", undefined);
  const { updateCrashReporting } = await loadCrashReports();
  updateCrashReporting();
  expect(initSentry).toHaveBeenCalledOnce();
});

it("tells an older desktop build without the crash report channel nothing about it", async () => {
  vi.stubGlobal("ohMyGameDesktop", {});
  const { updateCrashReporting } = await loadCrashReports();
  updateCrashReporting();
  expect(initSentry).toHaveBeenCalledOnce();
});
