// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentNotificationPermission } from "../src/shared/agent-notifications.js";

const notifications = {
  setPreferences: vi.fn(async () => undefined),
  setView: vi.fn(async () => undefined),
  takeTarget: vi.fn(async () => undefined),
  onTarget: vi.fn(() => () => undefined),
  permission: vi.fn(async (): Promise<AgentNotificationPermission> => "allowed"),
  requestPermission: vi.fn(async (): Promise<AgentNotificationPermission> => "allowed"),
  promptSent: vi.fn(async (): Promise<AgentNotificationPermission> => "allowed"),
  openSettings: vi.fn(async () => undefined),
};
Object.assign(window, { ohMyGameDesktop: { platform: "darwin", notifications } });
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({
  useAuth: () => ({ state: { status: "signed-out" }, openSignIn: vi.fn() }),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (importOriginal) => ({
  ...await importOriginal<object>(),
  getProjectLocation: async () => ({ storage: "/test/projects" }),
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
});

async function render(permission: AgentNotificationPermission): Promise<void> {
  notifications.permission.mockResolvedValue(permission);
  await act(async () => root.render(<SettingsPage section="notifications" onNavigate={() => {}} onSectionChange={() => {}} />));
}

function toggle(): HTMLButtonElement {
  return container.querySelector('[role="switch"]') as HTMLButtonElement;
}

it("asks macOS when notifications are turned on and it has not asked yet", async () => {
  localStorage.setItem("ohmygame:notifications", JSON.stringify({ enabled: false }));
  await render("not-determined");
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(notifications.requestPermission).toHaveBeenCalledOnce();
});

it("points blocked users to System Settings", async () => {
  localStorage.setItem("ohmygame:notifications", JSON.stringify({ enabled: true }));
  await render("denied");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Blocked by macOS.");
  await act(async () => container.querySelector<HTMLButtonElement>('[role="status"] button')!.click());
  expect(notifications.openSettings).toHaveBeenCalledOnce();

  await act(async () => toggle().click());
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("says nothing about the permission while notifications work", async () => {
  localStorage.setItem("ohmygame:notifications", JSON.stringify({ enabled: true }));
  await render("allowed");
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(notifications.requestPermission).not.toHaveBeenCalled();
});

it("preserves a disabled completion notification preference when upgrading", async () => {
  localStorage.removeItem("ohmygame:notifications");
  localStorage.setItem("ohmygame:run-notifications", "off");
  try {
    await render("allowed");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(JSON.parse(localStorage.getItem("ohmygame:notifications")!)).toEqual({ enabled: true });
  } finally {
    localStorage.removeItem("ohmygame:run-notifications");
  }
});


it("loads the desktop background choice and keeps it unchanged when saving fails", async () => {
  let finish!: (value: boolean) => void;
  const backgroundRunning = {
    get: vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; })),
    set: vi.fn(async (_enabled: boolean) => { throw new Error("Tray unavailable"); }),
  };
  Object.assign(window.ohMyGameDesktop!, { backgroundRunning });
  const control = () => container.querySelector('[role="switch"][aria-label="Keep running after closing the window"]') as HTMLButtonElement;
  try {
    await act(async () => root.render(<SettingsPage section="general" onNavigate={() => {}} onSectionChange={() => {}} />));
    expect(control().disabled).toBe(true);
    await act(async () => finish(false));
    expect(control().disabled).toBe(false);
    await act(async () => control().click());
    expect(backgroundRunning.set).toHaveBeenCalledWith(true);
    expect(control().getAttribute("aria-checked")).toBe("false");
    expect(control().closest("section")!.querySelector('[role="alert"]')!.textContent).toContain("Tray unavailable");
  } finally { delete window.ohMyGameDesktop!.backgroundRunning; }
});
