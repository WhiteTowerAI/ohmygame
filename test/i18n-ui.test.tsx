// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentModel } from "../src/shared/contracts.js";
import type { PlayablePresetSummary } from "../src/shared/playable-editor.js";

// The saved preference is read once, when the i18n module loads.
localStorage.setItem("ohmygame:language", "zh-CN");
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  getResponsesTransport: vi.fn(async () => ({ mode: "auto" })),
  updateResponsesTransport: vi.fn(),
  listProviders: vi.fn(async () => [
    {
      id: "deepseek",
      name: "DeepSeek",
      configured: true,
      capabilities: ["language"],
      status: "connected",
      methods: [],
    },
  ]),
  listAgentRuntimes: vi.fn(async () => []),
  listModels: vi.fn(async () => ({
    models: [],
    defaultReasoningLevel: "medium",
  })),
}));
const { language, t, tNodes } = await import("../src/renderer/i18n.js");
const { ProviderResponsesTransport } =
  await import("../src/renderer/responses-transport-settings.js");
const { CanvasTableAI, ExpandedCanvasTable } =
  await import("../src/renderer/canvas-table-node.js");
const { CanvasTableStorage } =
  await import("../src/renderer/canvas-table-storage.js");
const { createCanvasTable } = await import("../src/shared/canvas-table.js");
const { Onboarding } = await import("../src/renderer/onboarding.js");
const { ModelSelector } = await import("../src/renderer/model-selector.js");
const { PlayableTemplateDialog } = await import("../src/renderer/playable-template-dialog.js");
const { PlayableCanvasContextMenu } = await import("../src/renderer/playable-canvas-menus.js");
const { PLAYABLE_PRESETS } = await import("../src/daemon/playable-presets.js");

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("renders the saved Simplified Chinese preference", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  expect(language).toBe("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<ProviderResponsesTransport providerId="relay" />),
  );
  expect(host.querySelector("label")?.textContent).toBe("Responses 连接方式");
  expect(host.querySelector('option[value="auto"]')?.textContent).toBe("自动");
});

it("fills message placeholders with text or React nodes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  expect(t("planStatus.completed", { completed: 2, total: 5 })).toBe(
    "已完成 2 / 5 步",
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <p>
        {tNodes("sendToProject.added", {
          project: <strong>Demo</strong>,
          path: <code>assets/a.png</code>,
        })}
      </p>,
    ),
  );
  expect(host.innerHTML).toBe(
    "<p>已添加到 <strong>Demo</strong>：<code>assets/a.png</code></p>",
  );
});

it("shows table adoption and CSV replacement warnings in Chinese", () => {
  const table = createCanvasTable("Equipment", "items");
  const storage = new CanvasTableStorage("project");
  storage.changeGeneration(table.id, { proposal: table });
  const tables = { storage, open: vi.fn(), add: vi.fn() };
  const candidate = renderToStaticMarkup(
    <CanvasTableAI
      table={table}
      tables={tables}
      textModels={{ models: [], modelStatus: "ready" }}
    />,
  );
  expect(candidate).toContain("候选草稿——请检查后再替换表格。");
  expect(candidate).not.toContain("Candidate draft");
  const editor = renderToStaticMarkup(
    <ExpandedCanvasTable table={table} tables={tables} initialMode="edit" />,
  );
  expect(editor).toContain("导入 CSV 会替换表格，可通过撤销恢复。");
  expect(editor).not.toContain("Paste cells from a spreadsheet");
});

it("translates all three onboarding steps and preserves provider names", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const props = { onStepChange: vi.fn(), onFinish: vi.fn() };
  await act(async () => root!.render(<Onboarding step="welcome" {...props} />));
  expect(host.querySelector("h1")?.textContent).toBe("你的专属游戏工作室");
  expect(host.querySelector("footer")?.textContent).toBe("下一步");
  await act(async () => root!.render(<Onboarding step="connect" {...props} />));
  expect(host.querySelector("h1")?.textContent).toBe("连接你的 AI。");
  expect(host.querySelector(".onboarding-section-heading")?.textContent).toBe("连接智能体");
  expect(host.querySelector(".onboarding-agents-hint")?.textContent).toBe("可连接多个智能体，随时切换使用。");
  expect(host.querySelector(".onboarding-picker")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="OhMyGame"]')!.click());
  expect(host.querySelector(".onboarding-selected-agent button")?.textContent).toBe("切换");
  expect(host.querySelector(".onboarding-agents-hint")).toBeNull();
  expect(host.querySelector('[aria-label="DeepSeek"]')?.textContent).toBe(
    "DeepSeek",
  );
  expect(host.querySelector("footer")?.textContent).toBe("下一步跳过并开始");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="添加自定义服务商"]')!
      .click(),
  );
  expect(host.querySelector("h1")?.textContent).toBe("添加你的服务商。");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(
    host.querySelector('[aria-label="自定义服务商"]')?.textContent,
  ).toContain("显示名称");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        ".onboarding-progress > button:nth-child(2)",
      )!
      .click(),
  );
  expect(
    host
      .querySelector('[aria-label="DeepSeek"] button')
      ?.getAttribute("aria-label"),
  ).toBe("已连接");
  await act(async () => root!.render(<Onboarding step="media" {...props} />));
  expect(host.querySelector("h1")?.textContent).toBe("添加创作工具。");
  expect(host.querySelector("footer")?.textContent).toBe("开始创作");
  expect(host.querySelectorAll(".onboarding-progress > button")).toHaveLength(
    3,
  );
});

it("localizes the model selector back action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const model: AgentModel = { provider: "openai", providerName: "OpenAI", id: "test", name: "Test", reasoningLevels: ["medium", "high"] };
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ModelSelector models={[model]} value={model} reasoningLevel="medium" onChange={() => {}} onReasoningChange={() => {}} />));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>(".model-selector-reasoning")!.click());
  expect(document.querySelector<HTMLButtonElement>(".model-selector-back")?.getAttribute("aria-label")).toBe("返回模型列表");
});

it("localizes all Scene templates in the dialog and canvas menu without changing preset IDs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const presets: PlayablePresetSummary[] = PLAYABLE_PRESETS.map(({ id, label, summary }) => ({ id, label, summary }));
  const original = structuredClone(presets);
  presets.push({ id: "custom", label: "Custom template", summary: "A custom template description" });
  const expected = ["空白场景", "主菜单", "选项", "快速反应（QTE）", "热点交互", "结局", "故事地图", "视觉小说", "Custom template"];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onChoose = vi.fn();
  await act(async () => root!.render(<PlayableTemplateDialog presets={presets} busy={false} onChoose={onChoose} onClose={() => {}} />));
  expect([...host.querySelectorAll(".playable-template strong")].map((element) => element.textContent)).toEqual(expected);
  const summaries = [...host.querySelectorAll(".playable-template small")].map((element) => element.textContent);
  for (const preset of original) expect(summaries).not.toContain(preset.summary);
  expect(summaries[0]).toBe("播放视频或显示图片，然后进入下一幕");
  expect(summaries[8]).toBe("A custom template description");
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".playable-template")[5]!.click());
  expect(onChoose).toHaveBeenCalledWith("ending");

  await act(async () => root!.render(<PlayableCanvasContextMenu
    menu={{ kind: "pane", screenPosition: { x: 0, y: 0 }, flowPosition: { x: 0, y: 0 } }}
    presets={presets} canUndo={false} canRedo={false} canPaste={false} busy={false} isEntry={false}
    story={{ onMap: true, ending: false }} onClose={() => {}} onUndo={() => {}} onRedo={() => {}}
    onPaste={() => {}} onAdd={onChoose} onOpen={() => {}} onCopy={() => {}} onDuplicate={() => {}}
    onSetEntry={() => {}} onStoryOption={() => {}} onDelete={() => {}}
  />));
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  const entries = [...document.querySelectorAll<HTMLButtonElement>(".story-canvas-context-submenu button")];
  expect(entries.map((entry) => entry.textContent)).toEqual(expected);
  expect(entries.map((entry) => entry.title)).toEqual(summaries);
  await act(async () => entries[6]!.click());
  expect(onChoose).toHaveBeenLastCalledWith("story-map");
  expect(presets.slice(0, 8)).toEqual(original);
});
