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
