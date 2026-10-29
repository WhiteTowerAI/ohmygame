import { describe, expect, it } from "vitest";
import { AgentNotifications } from "../src/desktop/agent-notifications.js";
import type { AgentNotice, AgentNoticesResponse, AgentWaiting } from "../src/shared/agent-notices.js";
import { DEFAULT_AGENT_NOTIFICATION_PREFERENCES, parseAgentNotificationPreferences, parseAgentNotificationTarget, type AgentNotificationTarget } from "../src/shared/agent-notifications.js";

function notice(seq: number, kind: AgentNotice["kind"], conversationId = "c1", waitingId?: string): AgentNotice {
  return { seq, kind, projectId: "p1", projectName: "Space Game", conversationId, ...(waitingId ? { waitingId } : {}), at: 0 };
}

function setup() {
  let page: AgentNoticesResponse = { epoch: "e1", latestSeq: 0, notices: [], waiting: [] };
  let focused = false;
  const shown: { title: string; body: string; silent: boolean; closed: boolean; click: () => void }[] = [];
  const badges: number[] = [];
  const opened: AgentNotificationTarget[] = [];
  let attention = 0;
  const notifications = new AgentNotifications({
    notices: async (after) => ({ ...page, notices: page.notices.filter((item) => item.seq > after) }),
    focused: () => focused,
    show: (options, onClick) => {
      const entry = { ...options, closed: false, click: onClick };
      shown.push(entry);
      return { close: () => { entry.closed = true; } };
    },
    setBadgeCount: (count) => badges.push(count),
    requestAttention: () => { attention += 1; },
    open: (target) => opened.push(target),
  });
  return {
    notifications,
    shown,
    badges,
    opened,
    attention: () => attention,
    focus: (value: boolean) => { focused = value; },
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
    test.publish([notice(1, "approval", "c1", "w1")], [waitingApproval, { id: "w3", kind: "plan", projectId: "p1", conversationId: "c3" }]);
    await test.notifications.poll();
    expect(test.attention()).toBe(1);
    expect(test.badges).toEqual([2]);
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
    test.notifications.setPreferences({ ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES, sound: false, text: { ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES.text, completed: "已完成" } });
    test.publish([notice(1, "completed")], [waitingApproval]);
    await test.notifications.poll();
    expect(test.shown[0]).toMatchObject({ body: "已完成", silent: true });

    test.notifications.setPreferences({ ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES, enabled: false });
    expect(test.shown[0]?.closed).toBe(true);
    test.publish([notice(2, "completed")], [waitingApproval]);
    await test.notifications.poll();
    expect(test.shown).toHaveLength(1);
    expect(test.badges).toEqual([1, 0]);
  });

  it("checks what the renderer sends", () => {
    expect(parseAgentNotificationPreferences(DEFAULT_AGENT_NOTIFICATION_PREFERENCES)).toEqual(DEFAULT_AGENT_NOTIFICATION_PREFERENCES);
    expect(parseAgentNotificationPreferences({ enabled: true, sound: true, text: { ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES.text, plan: "" } })).toBeUndefined();
    expect(parseAgentNotificationTarget(null)).toBeNull();
    expect(parseAgentNotificationTarget({ projectId: "p1" })).toBeUndefined();
  });
});
