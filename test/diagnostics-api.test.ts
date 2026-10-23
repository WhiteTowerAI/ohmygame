// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { exportDiagnostics } from "../src/renderer/api.js";

afterEach(() => {
  Reflect.deleteProperty(window, "ohMyGameDesktop");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["headers", "body"])(
  "falls back when the daemon stalls while reading %s",
  async (stage) => {
    vi.useFakeTimers();
    const stalled = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options: RequestInit) => {
        if (stage === "headers") return stalled(options.signal!);
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          blob: () => stalled(options.signal!),
        });
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
    const pending = exportDiagnostics();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).blob.size).toBe(4);
    expect(desktopExport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("clears the timeout after a successful daemon export", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4]))),
  );
  expect((await exportDiagnostics()).blob.size).toBe(4);
  expect(vi.getTimerCount()).toBe(0);
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
