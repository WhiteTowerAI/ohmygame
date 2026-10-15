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

it("shows bundled notes in browser settings without an update bridge", async () => {
  Reflect.deleteProperty(window, "ohMyGameDesktop");
  await act(async () => root.render(
    <SettingsPage section="about" onBack={() => {}} onSectionChange={() => {}} onPluginChange={() => {}} onTryPlugin={async () => {}} />,
  ));
  expect(container.querySelector(".settings-changelog-content")?.textContent?.trim()).toBeTruthy();
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Release notes version"]')?.value).toBe(__APP_VERSION__);
  expect(container.textContent).not.toContain("Not checked yet");
  const links = container.querySelectorAll<HTMLAnchorElement>('[aria-label="Project links"] a');
  expect([...links].map((link) => link.href)).toEqual([
    "https://github.com/WhiteTowerAI/ohmygame",
    "https://ohmygame.ai/",
    "https://github.com/WhiteTowerAI/ohmygame/issues",
  ]);
  expect([...links].every((link) => link.target === "_blank" && link.rel.includes("noreferrer"))).toBe(true);
});

it("shows new notes received over the desktop update subscription while downloading", async () => {
  updates.state.mockResolvedValue({ currentVersion: "0.0.0-beta.4.6", status: { type: "idle" } });
  await act(async () => root.render(
    <SettingsPage section="about" onBack={() => {}} onSectionChange={() => {}} onPluginChange={() => {}} onTryPlugin={async () => {}} />,
  ));
  await act(async () => updates.onState.mock.calls[0][0]({
    currentVersion: "0.0.0-beta.4.6",
    status: { type: "downloading", version: "0.0.0-beta.4.7", percent: 50 },
    availableRelease: { version: "0.0.0-beta.4.7", notes: "### Fixed\n\n- Recover interrupted previews." },
  }));
  expect(container.textContent).toContain("Downloading update (50%)");
  expect(container.textContent).toContain("Recover interrupted previews.");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Release notes version"]')?.value).toBe("0.0.0-beta.4.7");
});

it("shows one update action and keeps download and restart controls tied to their phase", async () => {
  const available: DesktopUpdateState = {
    currentVersion: "0.0.0-beta.4.6",
    status: { type: "available", version: "0.0.0-beta.4.7" },
  };
  updates.state.mockResolvedValue(available);
  await act(async () => root.render(
    <SettingsPage section="about" onBack={() => {}} onSectionChange={() => {}} onPluginChange={() => {}} onTryPlugin={async () => {}} />,
  ));
  const action = () => container.querySelector<HTMLButtonElement>(".settings-about-actions button");
  expect(action()?.textContent).toBe("Download update");
  expect(container.querySelectorAll(".settings-about-actions button")).toHaveLength(1);
  action()!.click();
  expect(updates.download).toHaveBeenCalledOnce();

  const notify = updates.onState.mock.calls[0][0];
  await act(async () => notify({ ...available, status: { type: "downloading", version: "0.0.0-beta.4.7", percent: 50 } }));
  expect(action()).toBeNull();
  expect(container.textContent).toContain("Downloading update (50%)");

  await act(async () => notify({ ...available, status: { type: "ready", version: "0.0.0-beta.4.7" } }));
  expect(action()?.textContent).toBe("Restart to update");
  action()!.click();
  expect(updates.install).toHaveBeenCalledOnce();

  await act(async () => notify({ ...available, status: { type: "installing", version: "0.0.0-beta.4.7" } }));
  expect(action()).toBeNull();
  expect(container.textContent).toContain("Preparing a safe restart...");
});
