// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const exportDiagnostics = vi.fn();
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({
  useAuth: () => ({ state: { status: "signed-out" }, openSignIn: vi.fn() }),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (importOriginal) => ({
  ...(await importOriginal<object>()),
  exportDiagnostics,
}));
const { SettingsPage } = await import("../src/renderer/settings-page.js");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderAbout(): Promise<HTMLButtonElement> {
  await act(async () =>
    root.render(
      <SettingsPage
        section="about"
        onBack={() => {}}
        onSectionChange={() => {}}
      />,
    ),
  );
  return [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Export diagnostics",
  ) as HTMLButtonElement;
}

it("downloads the diagnostics bundle under the name the service gives it", async () => {
  const blob = new Blob(["zip"]);
  exportDiagnostics.mockResolvedValue({
    blob,
    fileName: "ohmygame-diagnostics-20261021-080000.zip",
  });
  const createObjectURL = vi.fn(() => "blob:diagnostics");
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("ohmygame-diagnostics-20261021-080000.zip");
      expect(this.href).toBe("blob:diagnostics");
    });

  const button = await renderAbout();
  await act(async () => button.click());

  expect(exportDiagnostics).toHaveBeenCalledOnce();
  expect(createObjectURL).toHaveBeenCalledWith(blob);
  expect(click).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("explains a failed export", async () => {
  exportDiagnostics.mockRejectedValue(new Error("The service is not running"));

  const button = await renderAbout();
  await act(async () => button.click());

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not export diagnostics: The service is not running",
  );
  expect(button.disabled).toBe(false);
});

it("opens the logs folder in the desktop app only", async () => {
  await renderAbout();
  expect(container.textContent).not.toContain("Open logs folder");
  await act(async () => root.unmount());
  root = createRoot(container);

  const openLogsDirectory = vi
    .fn()
    .mockRejectedValueOnce(new Error("Folder is not available"))
    .mockResolvedValueOnce(undefined);
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: { openLogsDirectory },
  });
  try {
    await renderAbout();
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Open logs folder",
    ) as HTMLButtonElement;
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not open the logs folder: Folder is not available",
    );
    await act(async () => button.click());
    expect(openLogsDirectory).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    Reflect.deleteProperty(window, "ohMyGameDesktop");
  }
});
