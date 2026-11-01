// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetLastProject, launchProject, readGeneralPreferences, rememberLastProject, sendsMessage, setGeneralPreference } from "../src/renderer/general-preferences.js";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const key = (init: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  ({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...init });

describe("General settings", () => {
  it("sends with Enter by default, or only with the platform's modifier", () => {
    expect(sendsMessage(key(), "enter")).toBe(true);
    expect(sendsMessage(key({ shiftKey: true }), "enter")).toBe(false);
    expect(sendsMessage(key({ key: "a" }), "enter")).toBe(false);
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    expect(sendsMessage(key(), "mod-enter")).toBe(false);
    expect(sendsMessage(key({ metaKey: true }), "mod-enter")).toBe(true);
    expect(sendsMessage(key({ ctrlKey: true }), "mod-enter")).toBe(false);
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32" });
    expect(sendsMessage(key({ ctrlKey: true }), "mod-enter")).toBe(true);
  });

  it("stores only choices that differ from the defaults and tells open screens", () => {
    const changed = vi.fn();
    window.addEventListener("ohmygame:general-preferences", changed);
    setGeneralPreference("sendKey", "mod-enter");
    setGeneralPreference("runSound", true);
    setGeneralPreference("keepAwake", false);
    expect(readGeneralPreferences()).toMatchObject({ sendKey: "mod-enter", runSound: true, keepAwake: false, autoUpdate: false });
    setGeneralPreference("sendKey", "enter");
    expect(localStorage.getItem("ohmygame:send-key")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(4);
    window.removeEventListener("ohmygame:general-preferences", changed);
  });

  it("reopens the last project only when asked, and never a deleted one", () => {
    rememberLastProject("p1");
    expect(launchProject()).toBeUndefined();
    setGeneralPreference("openTo", "last");
    expect(launchProject()).toBe("p1");
    forgetLastProject("p2");
    expect(launchProject()).toBe("p1");
    forgetLastProject("p1");
    expect(launchProject()).toBeUndefined();
  });
});
