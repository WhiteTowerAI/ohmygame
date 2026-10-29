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
vi.mock("posthog-js/dist/exception-autocapture.js", () => ({}));
vi.mock("posthog-js/dist/module.no-external.js", () => ({ posthog }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
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
