// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const posthog = {
  init: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  get_distinct_id: vi.fn(() => "anonymous-device"),
  get_property: vi.fn((): unknown => "anonymous"),
  has_opted_out_capturing: vi.fn(() => false),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  posthog.get_distinct_id.mockReturnValue("anonymous-device");
  posthog.get_property.mockReturnValue("anonymous");
  posthog.has_opted_out_capturing.mockReturnValue(false);
  vi.doMock("posthog-js/dist/module.no-external.js", () => ({ posthog }));
  localStorage.clear();
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
  vi.stubEnv("VITE_POSTHOG_HOST", "https://us.i.posthog.com");
  vi.stubGlobal("__APP_VERSION__", "0.0.0-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function loadAnalytics() {
  return import("../src/renderer/analytics.js");
}

async function settle(): Promise<void> {
  await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

it("identifies the signed-in account by id, also when sign-in is known before PostHog loads", async () => {
  const analytics = await loadAnalytics();
  analytics.setAnalyticsAccount("account-1");
  analytics.initializeAnalytics();
  await settle();
  expect(posthog.identify).toHaveBeenCalledExactlyOnceWith("account-1");

  posthog.get_distinct_id.mockReturnValue("account-1");
  analytics.setAnalyticsAccount("account-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.identify).toHaveBeenCalledOnce();
});

it("resets only an identified device on sign-out", async () => {
  const analytics = await loadAnalytics();
  analytics.initializeAnalytics();
  analytics.setAnalyticsAccount(null);
  await settle();
  expect(posthog.reset).not.toHaveBeenCalled();

  posthog.get_property.mockReturnValue("identified");
  analytics.setAnalyticsAccount(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.reset).toHaveBeenCalledOnce();
});

it("sends nothing while usage data is off and resumes when it is turned on", async () => {
  const analytics = await loadAnalytics();
  analytics.setUsageDataEnabled(false);
  analytics.initializeAnalytics();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.init).not.toHaveBeenCalled();
  expect(analytics.readUsageDataEnabled()).toBe(false);

  posthog.has_opted_out_capturing.mockReturnValue(true);
  analytics.setUsageDataEnabled(true);
  await settle();
  expect(posthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });

  analytics.setUsageDataEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
  expect(localStorage.getItem("ohmygame:usage-data")).toBe("off");
});

it("does not initialize when disabled while the SDK import is pending", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.doMock("posthog-js/dist/module.no-external.js", async () => { await held; return { posthog }; });
  const analytics = await loadAnalytics();
  analytics.initializeAnalytics();
  analytics.setUsageDataEnabled(false);
  analytics.setAnalyticsAccount("private-account");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.init).not.toHaveBeenCalled();
  expect(posthog.identify).not.toHaveBeenCalled();
  analytics.setUsageDataEnabled(true);
  await settle();
  expect(posthog.init).toHaveBeenCalledOnce();
  expect(posthog.identify).toHaveBeenCalledWith("private-account");
  expect(posthog.init.mock.calls[0]![1]).toMatchObject({ capture_exceptions: false, disable_session_recording: true });
});

it("keeps an off choice in memory if storage fails and does not identify while off", async () => {
  const analytics = await loadAnalytics();
  analytics.initializeAnalytics();
  await settle();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  analytics.setUsageDataEnabled(false);
  analytics.setAnalyticsAccount("private-account");
  expect(analytics.readUsageDataEnabled()).toBe(false);
  expect(posthog.identify).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
