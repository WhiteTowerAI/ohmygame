// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopUpdateState } from "../src/shared/desktop-update.js";

vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({
  useAuth: () => ({ state: { status: "signed-out" }, openSignIn: vi.fn() }),
}));
const { SettingsPage } = await import("../src/renderer/settings-page.js");

const failedUpdate: DesktopUpdateState = {
  currentVersion: "1.0.0",
  status: {
    type: "error",
    phase: "download",
    code: "network",
    title: "The update download was interrupted",
    message: "Check the network or proxy settings, then try again.",
    detail: "Error: read ECONNRESET",
    retry: "download",
    version: "1.1.0",
    dataSafe: true,
  },
};
const updates = {
  state: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  onState: vi.fn(),
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  updates.state.mockResolvedValue(failedUpdate);
  updates.onState.mockReturnValue(() => {});
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: { updates },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "ohMyGameDesktop");
  vi.unstubAllGlobals();
});

it("shows recovery actions and routes retry to the failed update phase", async () => {
  const onSectionChange = vi.fn();
  await act(async () => root.render(
    <SettingsPage
      section="about"
      onBack={() => {}}
      onSectionChange={onSectionChange}
      onPluginChange={() => {}}
      onTryPlugin={async () => {}}
    />,
  ));
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent)
    .toContain("Your projects and conversations were not deleted."));

  const button = (label: string) => [...container.querySelectorAll("button")]
    .find((item) => item.textContent === label) as HTMLButtonElement;
  button("Try again").click();
  expect(updates.download).toHaveBeenCalledOnce();
  expect(updates.check).not.toHaveBeenCalled();
  expect(button("Copy details")).toBeDefined();

  button("Network settings").click();
  expect(onSectionChange).toHaveBeenCalledWith("network");
});
