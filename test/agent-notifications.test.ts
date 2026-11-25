import { describe, expect, it } from "vitest";
import { AgentNotifications, trayBadgeBitmap, waitingDotBitmap } from "../src/desktop/agent-notifications.js";
import type { AgentNotice, AgentNoticesResponse, AgentWaiting } from "../src/shared/agent-notices.js";
import { NotificationPermission, permissionFromSettings, type MacNotificationCenter } from "../src/desktop/notification-permission.js";
import { DEFAULT_AGENT_NOTIFICATION_PREFERENCES, parseAgentNotificationPreferences, parseAgentNotificationTarget, parseAgentResultRead, type AgentNotificationPermission, type AgentNotificationTarget } from "../src/shared/agent-notifications.js";

function notice(seq: number, kind: AgentNotice["kind"], conversationId = "c1", waitingId?: string): AgentNotice {
  const result = kind === "completed" || kind === "failed";
  return { seq, kind, projectId: "p1", projectName: "Space Game", conversationId, ...(waitingId ? { waitingId } : {}), ...(result ? { resultEventId: seq * 10 } : {}), at: 0 };
}

function setup() {
  let page: AgentNoticesResponse = { epoch: "e1", latestSeq: 0, notices: [], waiting: [] };
  let focused = false;
  let permission: AgentNotificationPermission = "allowed";
  const shown: { title: string; body: string; closed: boolean; click: () => void }[] = [];
  const badges: number[] = [];
  const descriptions: string[] = [];
  const unreadBadges: number[] = [];
  const unreadDescriptions: string[] = [];
  const opened: AgentNotificationTarget[] = [];
  let attention = 0;
  const notifications = new AgentNotifications({
    notices: async (after) => ({ ...page, notices: page.notices.filter((item) => item.seq > after) }),
    focused: () => focused,
    permission: async () => permission,
    show: (options, onClick) => {
      const entry = { ...options, closed: false, click: onClick };
      shown.push(entry);
      return { close: () => { entry.closed = true; } };
    },
    showWaiting: (count, description) => {
      badges.push(count);
      descriptions.push(description);
    },
    showUnread: (count, description) => {
      unreadBadges.push(count);
      unreadDescriptions.push(description);
    },
    requestAttention: () => { attention += 1; },
    open: (target) => opened.push(target),
  });
  return {
    notifications,
    shown,
    badges,
    descriptions,
    unreadBadges,
    unreadDescriptions,
    opened,
    attention: () => attention,
    focus: (value: boolean) => { focused = value; },
    permit: (value: AgentNotificationPermission) => { permission = value; },
    publish: (notices: AgentNotice[], waiting: AgentWaiting[] = [], epoch = "e1") => {
      page = { epoch, latestSeq: Math.max(page.epoch === epoch ? page.latestSeq : 0, ...notices.map((item) => item.seq)), notices: page.epoch === epoch ? [...page.notices, ...notices] : notices, waiting };
    },
  };
}

const waitingApproval: AgentWaiting = { id: "w1", kind: "approval", projectId: "p1", conversationId: "c1" };

describe("agent notifications", () => {
  it("shows nothing recorded before it started listening", async () => {
    const test = setup();
    test.publish([notice(1, "completed")]);
    await test.notifications.poll();
    expect(test.shown).toEqual([]);

    test.publish([notice(2, "failed")]);
    await test.notifications.poll();
    expect(test.shown.map((item) => item.body)).toEqual(["Stopped with an error"]);
    expect(test.shown[0]?.title).toBe("Space Game");
  });

  it("does not replay notices after the daemon restarts", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "completed")]);
    await test.notifications.poll();
    test.publish([notice(1, "completed"), notice(2, "completed", "c2")], [], "e2");
    await test.notifications.poll();
    expect(test.shown).toHaveLength(1);
    expect(test.shown[0]?.closed).toBe(true);
  });

  it("announces finished turns only while the window is in the background", async () => {
    const test = setup();
    await test.notifications.poll();
    test.focus(true);
    test.publish([notice(1, "completed")]);
    await test.notifications.poll();
    expect(test.shown).toEqual([]);

    test.focus(false);
    test.publish([notice(2, "completed")]);
    await test.notifications.poll();
    expect(test.shown).toHaveLength(1);
    expect(test.attention()).toBe(0);
  });

  it("announces a request unless its conversation is in front", async () => {
    const test = setup();
    await test.notifications.poll();
    test.focus(true);
    test.notifications.setView({ projectId: "p1", conversationId: "c1" });
    test.publish([notice(1, "approval", "c1", "w1")], [waitingApproval]);
    await test.notifications.poll();
    expect(test.shown).toEqual([]);

    test.notifications.setView({ projectId: "p1", conversationId: "c2" });
    test.publish([notice(2, "question", "c1", "w2")], [waitingApproval, { ...waitingApproval, id: "w2", kind: "question" }]);
    await test.notifications.poll();
    expect(test.shown.map((item) => item.body)).toEqual(["Has a question for you"]);
    expect(test.attention()).toBe(0);
  });

  it("asks for attention and counts waiting conversations while in the background", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "approval", "c1", "w1")], [waitingApproval, { id: "w3", kind: "question", projectId: "p1", conversationId: "c3" }]);
    await test.notifications.poll();
    expect(test.attention()).toBe(1);
    expect(test.badges).toEqual([2]);
    expect(test.descriptions).toEqual(["Waiting for you"]);
  });

  it("draws a dot for the Windows taskbar", () => {
    const dot = waitingDotBitmap(16);
    const pixel = (x: number, y: number) => [...dot.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(dot).toHaveLength(16 * 16 * 4);
    expect(pixel(8, 8)).toEqual([0x4d, 0x48, 0xe5, 0xff]);
    expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("keeps other conversations unread and ignores focus, navigation and stale cursors", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "completed"), notice(2, "failed", "c2")]);
    await test.notifications.poll();
    expect(test.unreadBadges).toEqual([1, 2]);
    expect(test.unreadDescriptions).toEqual(["Unread results", "Unread results"]);

    test.focus(true);
    test.notifications.focusChanged();
    const target = { projectId: "p1", conversationId: "c1" };
    test.notifications.setView(target);
    test.notifications.markResultRead({ ...target, epoch: "old", eventId: 999 });
    test.notifications.markResultRead({ ...target, epoch: "e1", eventId: 9 });
    expect(test.unreadBadges).toEqual([1, 2]);
    test.notifications.markResultRead({ ...target, epoch: "e1", eventId: 10 });
    expect(test.unreadBadges).toEqual([1, 2, 1]);
  });

  it("keeps only the newest result per conversation and does not restore a result already read", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "completed"), notice(2, "failed"), { ...notice(3, "completed"), resultEventId: 15 }]);
    await test.notifications.poll();
    const target = { projectId: "p1", conversationId: "c1", epoch: "e1" };
    test.notifications.markResultRead({ ...target, eventId: 15 });
    expect(test.unreadBadges).toEqual([1]);
    test.notifications.markResultRead({ ...target, eventId: 40 });
    expect(test.unreadBadges).toEqual([1, 0]);

    // The latest result was seen while focused, but the notice arrived after blur.
    test.notifications.markResultRead({ ...target, eventId: 30 });
    test.publish([notice(4, "completed")]);
    await test.notifications.poll();
    expect(test.unreadBadges).toEqual([1, 0]);
    expect(test.shown.map((item) => item.body)).toEqual(["Finished", "Stopped with an error"]);
  });

  it("does not count a result the window was in front for", async () => {
    const test = setup();
    await test.notifications.poll();
    test.focus(true);
    test.publish([notice(1, "completed")]);
    await test.notifications.poll();
    expect(test.unreadBadges).toEqual([]);
  });

  it("keeps counting unread results while the system blocks notifications", async () => {
    const test = setup();
    await test.notifications.poll();
    test.permit("denied");
    test.publish([notice(1, "completed")]);
    await test.notifications.poll();
    expect(test.shown).toEqual([]);
    expect(test.unreadBadges).toEqual([1]);
  });

  it("clears unread results when the daemon restarts or notifications turn off", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "completed")]);
    await test.notifications.poll();
    // The renderer can observe the new daemon epoch before the desktop poll.
    test.notifications.markResultRead({ projectId: "p1", conversationId: "c1", epoch: "e2", eventId: 20 });
    test.publish([notice(1, "completed")], [], "e2");
    await test.notifications.poll();
    expect(test.unreadBadges).toEqual([1, 0]);

    test.publish([notice(2, "completed"), notice(3, "completed", "c2")], [], "e2");
    await test.notifications.poll();
    expect(test.unreadBadges).toEqual([1, 0, 1]);
    test.notifications.setPreferences({ ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES, enabled: false });
    expect(test.unreadBadges).toEqual([1, 0, 1, 0]);
  });

  it("draws an upper-right dot without changing the rest of the Windows tray icon", () => {
    const base = Buffer.alloc(16 * 16 * 4, 0x22);
    const badge = trayBadgeBitmap(base, { width: 16, height: 16 });
    const pixel = (x: number, y: number) => [...badge.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(pixel(4, 12)).toEqual([0x22, 0x22, 0x22, 0x22]);
    expect(pixel(12, 4)).toEqual([0x4d, 0x48, 0xe5, 0xff]);
    expect(base.every((byte) => byte === 0x22)).toBe(true);
  });

  it("withdraws a request answered elsewhere and the conversation's notification once it is in front", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "approval", "c1", "w1")], [waitingApproval]);
    await test.notifications.poll();
    test.publish([], []);
    await test.notifications.poll();
    expect(test.shown[0]?.closed).toBe(true);
    expect(test.badges).toEqual([1, 0]);

    test.publish([notice(2, "completed", "c2")]);
    await test.notifications.poll();
    test.focus(true);
    test.notifications.setView({ projectId: "p1", conversationId: "c2" });
    expect(test.shown[1]?.closed).toBe(true);
  });

  it("replaces a conversation's notification with its newer one", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "approval", "c1", "w1"), notice(2, "failed", "c1")], [waitingApproval]);
    await test.notifications.poll();
    expect(test.shown.map((item) => item.closed)).toEqual([true, false]);
  });

  it("skips a request answered before it was read", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "approval", "c1", "w1")], []);
    await test.notifications.poll();
    expect(test.shown).toEqual([]);
    expect(test.attention()).toBe(0);
  });

  it("opens the conversation of a clicked notification", async () => {
    const test = setup();
    await test.notifications.poll();
    test.publish([notice(1, "completed")]);
    await test.notifications.poll();
    test.shown[0]?.click();
    expect(test.opened).toEqual([{ projectId: "p1", conversationId: "c1" }]);
  });

  it("follows the settings and wording it was sent", async () => {
    const test = setup();
    await test.notifications.poll();
    test.notifications.setPreferences({ ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES, text: { ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES.text, completed: "已完成" } });
    test.publish([notice(1, "completed")], [waitingApproval]);
    await test.notifications.poll();
    expect(test.shown[0]).toMatchObject({ body: "已完成" });

    test.notifications.setPreferences({ ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES, enabled: false });
    expect(test.shown[0]?.closed).toBe(true);
    test.publish([notice(2, "completed")], [waitingApproval]);
    await test.notifications.poll();
    expect(test.shown).toHaveLength(1);
    expect(test.badges).toEqual([1, 0]);
  });

  it("shows nothing while the system blocks notifications", async () => {
    const test = setup();
    await test.notifications.poll();
    test.permit("denied");
    test.publish([notice(1, "approval", "c1", "w1")], [waitingApproval]);
    await test.notifications.poll();
    expect(test.shown).toEqual([]);
    expect(test.badges).toEqual([1]);

    // Undecided: Electron asks macOS itself when it shows one.
    test.permit("not-determined");
    test.publish([notice(2, "completed", "c2")], [waitingApproval]);
    await test.notifications.poll();
    expect(test.shown.map((item) => item.body)).toEqual(["Finished"]);
  });

  it("checks what the renderer sends", () => {
    expect(parseAgentNotificationPreferences(DEFAULT_AGENT_NOTIFICATION_PREFERENCES)).toEqual(DEFAULT_AGENT_NOTIFICATION_PREFERENCES);
    expect(parseAgentNotificationPreferences({ enabled: true, text: { ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES.text, question: "" } })).toBeUndefined();
    expect(parseAgentNotificationTarget(null)).toBeNull();
    expect(parseAgentNotificationTarget({ projectId: "p1" })).toBeUndefined();
    const result = { projectId: "p1", conversationId: "c1", epoch: "e1", eventId: 10 };
    expect(parseAgentResultRead(result)).toEqual(result);
    expect(parseAgentResultRead({ ...result, epoch: "" })).toBeUndefined();
    expect(parseAgentResultRead({ ...result, eventId: 0.5 })).toBeUndefined();
  });
});

describe("notification permission", () => {
  function center(status: number, granted = true) {
    const state = { status, requests: 0 };
    const value: MacNotificationCenter = {
      bundleId: "ai.ohmygame.desktop",
      settings: async () => ({ authorizationStatus: state.status, alertStyle: 1 }),
      requestAuthorization: async () => {
        state.requests += 1;
        state.status = granted ? 2 : 1;
        return granted;
      },
    };
    return { state, value };
  }

  function permission(options: { platform?: NodeJS.Platform; packaged?: boolean; center?: MacNotificationCenter } = {}) {
    const opened: string[] = [];
    const subject = new NotificationPermission({
      platform: options.platform ?? "darwin",
      packaged: options.packaged ?? true,
      openExternal: async (url) => { opened.push(url); },
      loadCenter: async () => options.center ?? center(2).value,
    });
    return { subject, opened };
  }

  it("reads what macOS allows", () => {
    expect(permissionFromSettings({ authorizationStatus: 0, alertStyle: 1 })).toBe("not-determined");
    expect(permissionFromSettings({ authorizationStatus: 1, alertStyle: 1 })).toBe("denied");
    expect(permissionFromSettings({ authorizationStatus: 2, alertStyle: 1 })).toBe("allowed");
    expect(permissionFromSettings({ authorizationStatus: 2, alertStyle: 0 })).toBe("quiet");
    expect(permissionFromSettings({ authorizationStatus: 3, alertStyle: 1 })).toBe("quiet");
  });

  it("asks only while the user has not decided, and once per launch", async () => {
    const undecided = center(0);
    const { subject } = permission({ center: undecided.value });
    expect(await subject.requestOncePerLaunch()).toBe("allowed");
    undecided.state.status = 0;
    expect(await subject.requestOncePerLaunch()).toBe("not-determined");
    expect(undecided.state.requests).toBe(1);

    const denied = center(1);
    expect(await permission({ center: denied.value }).subject.request()).toBe("denied");
    expect(denied.state.requests).toBe(0);
  });

  it("cannot read the permission outside a packaged macOS app", async () => {
    expect(await permission({ packaged: false }).subject.status()).toBe("unavailable");
    expect(await permission({ platform: "win32" }).subject.status()).toBe("unknown");
  });

  it("opens the app's own notification settings", async () => {
    const mac = permission();
    await mac.subject.openSettings();
    expect(mac.opened).toEqual(["x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=ai.ohmygame.desktop"]);
    const windows = permission({ platform: "win32" });
    await windows.subject.openSettings();
    expect(windows.opened).toEqual(["ms-settings:notifications"]);
  });
});
