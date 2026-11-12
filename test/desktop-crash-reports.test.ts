import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initSentry: vi.fn(),
  makeElectronOfflineTransport: vi.fn(),
  innerSend: vi.fn(async () => ({ statusCode: 200 })),
  userData: { current: "" },
}));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userData.current },
}));

vi.mock("@sentry/electron/main", () => ({
  init: mocks.initSentry,
  makeElectronOfflineTransport: mocks.makeElectronOfflineTransport,
}));

const directories: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.userData.current = await mkdtemp(path.join(tmpdir(), "ohmygame-crash-reports-"));
  directories.push(mocks.userData.current);
  mocks.makeElectronOfflineTransport.mockReturnValue(() => ({
    send: mocks.innerSend,
    flush: async () => true,
  }));
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type SentryOptions = {
  dsn?: string;
  enabled?: boolean;
  transport?: (options: unknown) => { send: (request: unknown) => Promise<unknown> };
};

// Imported fresh in each test so vi.resetModules() gives the module a fresh state.
async function loadCrashReports() {
  return import("../src/desktop/crash-reports.js");
}

function installedTransport(): { send: (request: unknown) => Promise<unknown> } {
  const options = mocks.initSentry.mock.lastCall![0] as SentryOptions;
  if (!options.transport) throw new Error("Sentry was installed without the gated transport");
  return options.transport({});
}

async function crashReportFile(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(mocks.userData.current, "crash-reports.json"), "utf8"));
}

it("installs crash reporting with its gate open when nothing is stored", async () => {
  const { initCrashReporting } = await loadCrashReports();
  await initCrashReporting("https://sentry.dsn");
  expect(mocks.initSentry).toHaveBeenCalledWith(
    expect.objectContaining({ dsn: "https://sentry.dsn", enabled: true, sendDefaultPii: false }),
  );
  await installedTransport().send({ body: "" });
  expect(mocks.innerSend).toHaveBeenCalledOnce();
});

it("starts with its gate closed when the stored choice is off", async () => {
  await writeFile(path.join(mocks.userData.current, "crash-reports.json"), JSON.stringify({ enabled: false }));
  const { initCrashReporting } = await loadCrashReports();
  await initCrashReporting("https://sentry.dsn");
  const response = await installedTransport().send({ body: "" });
  expect(mocks.innerSend).not.toHaveBeenCalled();
  // A dropped envelope answers as delivered, so the offline store does not keep it.
  expect(response).toEqual({});
});

it("defaults to open when the stored file is missing or unreadable", async () => {
  await writeFile(path.join(mocks.userData.current, "crash-reports.json"), "not JSON");
  const { initCrashReporting } = await loadCrashReports();
  await initCrashReporting("https://sentry.dsn");
  await installedTransport().send({ body: "" });
  expect(mocks.innerSend).toHaveBeenCalledOnce();
});

it("applies and stores the renderer's choice, closing the gate immediately", async () => {
  const { initCrashReporting, setCrashReportingEnabled } = await loadCrashReports();
  await initCrashReporting("https://sentry.dsn");
  setCrashReportingEnabled(false);
  expect(await crashReportFile()).toEqual({ enabled: false });
  await installedTransport().send({ body: "" });
  expect(mocks.innerSend).not.toHaveBeenCalled();
});

it("reopens the gate when the renderer turns usage data back on", async () => {
  const { initCrashReporting, setCrashReportingEnabled } = await loadCrashReports();
  await initCrashReporting("https://sentry.dsn");
  setCrashReportingEnabled(false);
  setCrashReportingEnabled(true);
  expect(await crashReportFile()).toEqual({ enabled: true });
  await installedTransport().send({ body: "" });
  expect(mocks.innerSend).toHaveBeenCalledOnce();
});

it("installs without reporting when there is no DSN", async () => {
  const { initCrashReporting } = await loadCrashReports();
  await initCrashReporting(undefined);
  expect(mocks.initSentry).toHaveBeenCalledWith(
    expect.objectContaining({ dsn: undefined, enabled: false }),
  );
});
