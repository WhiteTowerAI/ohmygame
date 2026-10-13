// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

// The saved preference is read once, when the i18n module loads.
localStorage.setItem("ohmygame:language", "zh-CN");
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  getResponsesTransport: vi.fn(async () => ({ mode: "auto" })),
  updateResponsesTransport: vi.fn(),
}));
const { language, t, tNodes } = await import("../src/renderer/i18n.js");
const { ProviderResponsesTransport } =
  await import("../src/renderer/responses-transport-settings.js");

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
