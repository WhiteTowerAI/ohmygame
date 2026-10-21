// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { exportDiagnostics } from "../src/renderer/api.js";

afterEach(() => {
  Reflect.deleteProperty(window, "ohMyGameDesktop");
  vi.unstubAllGlobals();
});

it("builds the diagnostics in the desktop app when the service cannot", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  const desktopExport = vi.fn(async () => new Uint8Array([80, 75, 3, 4]));
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: {
      runtime: { daemonUrl: "http://127.0.0.1:50000", token: "token" },
      exportDiagnostics: desktopExport,
    },
  });

  const { blob, fileName } = await exportDiagnostics();

  expect(desktopExport).toHaveBeenCalledOnce();
  expect(blob.type).toBe("application/zip");
  expect(blob.size).toBe(4);
  expect(fileName).toMatch(/^ohmygame-diagnostics-\d{8}-\d{6}\.zip$/);
});

it("reports the service's error when there is no desktop app to fall back on", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );

  await expect(exportDiagnostics()).rejects.toThrow("Failed to fetch");
});
