// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSummary } from "../src/shared/contracts.js";
import { CODEX_IMAGE_MODEL } from "../src/daemon/agent-runtimes/codex-image-provider.js";

const provider: ProviderSummary = {
  id: "codex-cli",
  name: "Codex CLI",
  configured: true,
  enabled: true,
  status: "connected",
  capabilities: ["image"],
  methods: [],
};
const api = {
  listImageModelCatalog: vi.fn(async () => ({
    models: [CODEX_IMAGE_MODEL],
    providers: [],
  })),
  listVideoModelCatalog: vi.fn(async () => ({ models: [], providers: [] })),
  listModel3DCatalog: vi.fn(async () => ({ models: [], providers: [] })),
  recheckCodexImages: vi.fn(async () => ({
    ...provider,
    configured: false,
    status: "not_configured" as const,
    error: "Sign in to Codex CLI",
  })),
  setProviderEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
    ...provider,
    enabled,
  })),
  notifyAgentModelsChanged: vi.fn(),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { ModelsSettings } = await import("../src/renderer/models-settings.js");
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

it("offers an independent image switch and recheck without an API key form", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const openAgents = vi.fn();
  await act(async () =>
    root!.render(
      <ModelsSettings
        view={{ page: "provider", provider }}
        onViewChange={() => {}}
        onOpenAgents={openAgents}
      />,
    ),
  );
  expect(host.textContent).toContain("Codex Image");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  const toggle = host.querySelector<HTMLInputElement>('input[role="switch"]')!;
  await act(async () => toggle.click());
  expect(api.setProviderEnabled).toHaveBeenCalledWith("codex-cli", false);
  const refresh = [...host.querySelectorAll("button")].find((button) =>
    /Check again|重新检测/.test(button.textContent ?? ""),
  )!;
  await act(async () => refresh.click());
  expect(api.recheckCodexImages).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Sign in to Codex CLI");
  expect(
    host.querySelector<HTMLInputElement>('input[role="switch"]')!.checked,
  ).toBe(false);
  expect(openAgents).not.toHaveBeenCalled();
});

it("keeps the image switch available before a disabled provider has been checked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ModelsSettings
        view={{
          page: "provider",
          provider: {
            ...provider,
            configured: false,
            enabled: false,
            status: "not_configured",
          },
        }}
        onViewChange={() => {}}
        onOpenAgents={() => {}}
      />,
    ),
  );
  const toggle = host.querySelector<HTMLInputElement>('input[role="switch"]')!;
  expect(toggle.checked).toBe(false);
  await act(async () => toggle.click());
  expect(api.setProviderEnabled).toHaveBeenLastCalledWith("codex-cli", true);
  expect(toggle.checked).toBe(true);
});
