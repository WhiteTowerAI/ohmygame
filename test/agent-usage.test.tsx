// @vitest-environment happy-dom
import { act } from "react";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AgentUsageDetails,
  AgentUsageInline,
  usageResetLabel,
  usageWindowLabel,
} from "../src/renderer/agent-usage.js";
import { AgentAccountMenu } from "../src/renderer/agent-account-menu.js";

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("names quota windows by their length and their bucket when it is not the main one", () => {
  const label = (windowMinutes: number | undefined, id = "codex/primary") =>
    usageWindowLabel({ id, usedPercent: 0, windowMinutes });
  expect(label(300)).toBe("5-hour");
  expect(label(10080)).toBe("Weekly");
  expect(label(1440)).toBe("Daily");
  expect(label(4320)).toBe("3-day");
  expect(label(90)).toBe("90-minute");
  expect(label(undefined)).toBe("Limit");
  expect(label(300, "codex_spark/primary")).toBe("codex_spark · 5-hour");
});

it("shows each window's share used, warns near the limit and treats a passed reset as empty", async () => {
  const now = 1_000_000_000_000;
  const limits = [
    {
      id: "claude/five_hour",
      usedPercent: 13.4,
      windowMinutes: 300,
      resetsAt: now / 1000 + 3600,
    },
    {
      id: "claude/seven_day",
      usedPercent: 96,
      windowMinutes: 10080,
      resetsAt: now / 1000 + 86400,
    },
    {
      id: "codex/primary",
      usedPercent: 85,
      windowMinutes: 300,
      resetsAt: now / 1000 - 60,
    },
  ];
  await act(async () =>
    root.render(<AgentUsageInline limits={limits} now={now} />),
  );
  expect(container.textContent).toBe("5-hour13% usedWeekly96% used5-hour0% used");
  const meters = [...container.querySelectorAll('[role="meter"]')];
  expect(meters.map((meter) => meter.className)).toEqual([
    "cloud-quota-meter agent-usage-meter",
    "cloud-quota-meter agent-usage-meter is-danger",
    "cloud-quota-meter agent-usage-meter",
  ]);
  await act(async () =>
    root.render(<AgentUsageInline limits={limits} now={now} compact />),
  );
  expect(container.textContent).toBe("5-hour13%Weekly96%5-hour0%");
  expect(
    [...container.querySelectorAll(".agent-usage-inline > span")].map(
      (window) => window.getAttribute("title"),
    ),
  ).toEqual([
    "5-hour · 13% used · Resets in 1h 0m",
    "Weekly · 96% used · Resets in 1d 0h",
    "5-hour · 0% used · Reset since last report",
  ]);
  expect(
    [...container.querySelectorAll('[role="meter"]')].map(
      (meter) => meter.getAttribute("aria-valuetext"),
    ),
  ).toEqual(["13% used", "96% used", "0% used"]);
  await act(async () =>
    root.render(<AgentUsageDetails limits={limits} now={now} />),
  );
  expect(container.textContent).toContain("13% used");
  expect(container.textContent).toContain("Resets ");
  expect(container.textContent).toContain("Reset since last report");
});

it("translates the compact quota tooltip and accessible value into Chinese", async () => {
  const previousLanguage = i18next.language;
  await i18next.changeLanguage("zh-CN");
  try {
    await act(async () =>
      root.render(
        <AgentUsageInline
          limits={[
            { id: "codex/secondary", usedPercent: 93, windowMinutes: 10080 },
          ]}
          compact
        />,
      ),
    );
    expect(container.textContent).toBe("每周93%");
    expect(
      container.querySelector(".agent-usage-inline > span")?.getAttribute("title"),
    ).toBe("每周 · 已用 93%");
    expect(
      container.querySelector('[role="meter"]')?.getAttribute("aria-valuetext"),
    ).toBe("已用 93%");
  } finally {
    await i18next.changeLanguage(previousLanguage);
  }
});

it("says how long until a window resets, and that a passed one was reset", () => {
  const now = 1_000_000_000_000;
  const at = (minutes: number) => ({ id: "claude/five_hour", usedPercent: 40, resetsAt: (now + minutes * 60_000) / 1000 });
  expect(usageResetLabel(at(147), now)).toBe("Resets in 2h 27m");
  expect(usageResetLabel(at(9 * 24 * 60 + 600), now)).toBe("Resets in 9d 10h");
  expect(usageResetLabel(at(0.5), now)).toBe("Resets in 1m");
  expect(usageResetLabel(at(-1), now)).toBe("Reset since last report");
  expect(usageResetLabel({ id: "codex/primary", usedPercent: 0 }, now)).toBeUndefined();
});

it("lists every account with its 5-hour share and a ring per window, and shows any account's windows on hover", async () => {
  vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    const now = Date.now();
    const window_ = (minutes: number, usedPercent: number, resetIn: number) => ({ id: `claude/${minutes === 300 ? "five_hour" : "seven_day"}`, usedPercent, windowMinutes: minutes, resetsAt: (now + resetIn * 60_000) / 1000 });
    const profile = (id: string, name: string, account: string, limits: ReturnType<typeof window_>[]) => ({
      id, name, auth: { status: "signed-in" as const, account, billing: "subscription" as const }, limits,
    });
    const onChange = vi.fn();
    // The weekly window comes first, as a report may list it; the 5-hour share still leads.
    await act(async () => root.render(<AgentAccountMenu runtime="claude-code-cli" value="system" disabled={false} onChange={onChange} onRefresh={async () => {}}
      profiles={[profile("system", "System", "me@example.com", [window_(10080, 2, 9840), window_(300, 17, 286)]), profile("b", "B", "b@example.com", [window_(300, 46, 146), window_(10080, 100, 3960)])]} />));
    const trigger = container.querySelector<HTMLButtonElement>(".agent-account-trigger")!;
    expect(trigger.textContent).toBe("Default17%");
    await act(async () => trigger.click());
    const menu = document.querySelector(".agent-account-menu")!;
    expect(menu.querySelector(".agent-account-heading")!.textContent).toBe("Accounts");
    expect([...menu.querySelectorAll(".agent-account-heading button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Manage accounts", "Refresh accounts"]);
    const rows = [...menu.querySelectorAll<HTMLButtonElement>(".agent-account-row")];
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(rows.map((row) => row.querySelector(".agent-account-row-usage")?.textContent)).toEqual(["17%", "46%"]);
    expect([...rows[1]!.querySelectorAll(".agent-account-ring")].map((ring) => ring.getAttribute("class"))).toEqual(["agent-account-ring", "agent-account-ring is-danger"]);

    // The chosen account's windows show on hover too, and count down while the menu is open.
    await act(async () => rows[0]!.focus());
    const windows = () => [...document.querySelectorAll(".agent-account-peek .agent-account-window")].map((row) => row.textContent);
    expect(windows()).toEqual(["Weekly2%Resets in 6d 20h", "5-hour17%Resets in 4h 46m"]);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(windows()[1]).toBe("5-hour17%Resets in 4h 45m");
    await act(async () => rows[1]!.focus());
    const peek = document.querySelector(".agent-account-peek")!;
    expect(peek.querySelector("strong")?.textContent).toBe("b@example.com");
    // A native game preview steps aside for it, as for the menu itself.
    expect(peek.hasAttribute("data-native-preview-overlay")).toBe(true);
    expect(windows()).toEqual(["5-hour46%Resets in 2h 25m", "Weekly100%Resets in 2d 17h"]);
    await act(async () => rows[1]!.click());
    expect(onChange).toHaveBeenCalledWith("b");
    expect(document.querySelector(".agent-account-menu")).toBeNull();
    expect(document.querySelector(".agent-account-peek")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
