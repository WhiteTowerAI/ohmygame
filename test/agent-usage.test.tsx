// @vitest-environment happy-dom
import { act } from "react";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AgentUsageDetails,
  AgentUsageInline,
  usageWindowLabel,
} from "../src/renderer/agent-usage.js";

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
  ).toEqual(["5-hour · 13% used", "Weekly · 96% used", "5-hour · 0% used"]);
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
