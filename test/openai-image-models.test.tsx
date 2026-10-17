// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenAIImageConnectionSettings } from "../src/shared/contracts.js";

const api = { get: vi.fn(), save: vi.fn(), discover: vi.fn(), remove: vi.fn() };
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  getOpenAIImageSettings: api.get,
  saveOpenAIImageSettings: api.save,
  discoverOpenAIImageModels: api.discover,
  removeOpenAIImageSettings: api.remove,
}));
const { OpenAIImageModels } =
  await import("../src/renderer/openai-image-models.js");
const initial: OpenAIImageConnectionSettings = {
  mode: "connection",
  baseUrl: "https://api.openai.com/v1",
  configured: false,
  connectionAvailable: false,
  models: [],
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const changed = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockResolvedValue(initial);
  api.discover.mockResolvedValue({
    models: [
      {
        id: "gpt-image-2",
        name: "GPT Image 2",
        template: "gpt-image-2",
        enabled: false,
      },
    ],
  });
  api.save.mockImplementation(async (value) => ({
    ...initial,
    ...value,
    apiKey: undefined,
    configured: true,
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () =>
    root.render(<OpenAIImageModels revision={0} onChanged={changed} />),
  );
const button = (text: string) =>
  [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  )!;
async function fill(label: string, value: string) {
  const element = [...container.querySelectorAll("label")]
    .find((labelElement) => labelElement.textContent?.includes(label))!
    .querySelector("input,select")! as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function clickLabel(label: string) {
  await act(async () =>
    (
      container.querySelector(
        `button[aria-label="${label}"]`,
      ) as HTMLButtonElement
    ).click(),
  );
}
async function save() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("configures an independent relay for browser sign-in, previews models, then saves enabled choices", async () => {
  await render();
  expect(container.querySelector("input,select")).toBeNull();
  expect(button("Save")).toBeUndefined();
  await click("Connect");
  expect(button("Save").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(false);
  expect(
    container
      .querySelector('option[value="connection"]')
      ?.hasAttribute("disabled"),
  ).toBe(true);
  await fill("Image API key", "relay-key");
  await fill("Image Base URL", "https://relay.test/v1");
  await click("Fetch models");
  expect(api.discover).toHaveBeenCalledWith(
    { mode: "separate", apiKey: "relay-key", baseUrl: "https://relay.test/v1" },
    expect.any(AbortSignal),
  );
  expect(api.save).not.toHaveBeenCalled();
  await act(async () =>
    (
      container.querySelector(
        '[aria-label="Enable GPT Image 2"]',
      ) as HTMLInputElement
    ).click(),
  );
  await save();
  expect(api.save).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "separate",
      apiKey: "relay-key",
      models: [expect.objectContaining({ id: "gpt-image-2", enabled: true })],
    }),
  );
  expect(changed).toHaveBeenCalledWith(true);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(button("Save")).toBeUndefined();
  expect(container.textContent).toContain("GPT Image 2");
});

it("adds a model alias without discovery and saves its selected capability template", async () => {
  await render();
  await click("Connect");
  await fill("Image API key", "relay-key");
  await click("Add model");
  await fill("Model ID", "my-relay-alias");
  await fill("Capability template", "gpt-image-1");
  await click("Add");
  await save();
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.save).toHaveBeenCalledWith(
    expect.objectContaining({
      models: [
        {
          id: "my-relay-alias",
          name: "my-relay-alias",
          template: "gpt-image-1",
          enabled: true,
        },
      ],
    }),
  );
});

it("cancels stale discovery when the endpoint changes and restores saved choices on cancel", async () => {
  api.get.mockResolvedValue({
    ...initial,
    mode: "separate",
    configured: true,
    models: [
      { id: "saved", name: "Saved", template: "gpt-image-1", enabled: true },
    ],
  });
  let finish!: (value: unknown) => void;
  api.discover.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click("Edit");
  await click("Fetch models");
  const signal = api.discover.mock.calls[0]![1] as AbortSignal;
  await clickLabel("Edit image Base URL");
  await fill("Image Base URL", "https://other.test/v1");
  expect(signal.aborted).toBe(true);
  await act(async () =>
    finish({
      models: [
        { id: "stale", name: "Stale", template: "gpt-image-2", enabled: false },
      ],
    }),
  );
  expect(container.textContent).not.toContain("Stale");
  expect(button("Fetch models").disabled).toBe(true);
  expect(
    (container.querySelector('input[type="password"]') as HTMLInputElement)
      .required,
  ).toBe(true);
  await click("Cancel");
  expect(container.textContent).toContain("Saved");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await click("Edit");
  expect(button("Fetch models").disabled).toBe(false);
});

it("merges refreshed models without changing saved aliases, templates or enable choices", async () => {
  api.get.mockResolvedValue({
    ...initial,
    mode: "separate",
    configured: true,
    models: [
      {
        id: "gpt-image-2",
        name: "My image",
        template: "gpt-image-1",
        enabled: true,
      },
      { id: "manual", name: "Manual", template: "gpt-image-2", enabled: false },
    ],
  });
  await render();
  expect(container.textContent).toContain("My image");
  expect(container.textContent).not.toContain("Manual");
  expect(container.querySelector("select")).toBeNull();
  await click("Edit");
  await click("Fetch models");
  expect(container.textContent).toContain("My image");
  expect(container.textContent).toContain("Manual");
  expect(
    (
      container.querySelector(
        '[aria-label="Enable My image"]',
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
  await clickLabel("Edit My image");
  expect(
    (
      container.querySelector(
        '[aria-label="Capability template for gpt-image-2"]',
      ) as HTMLSelectElement
    ).value,
  ).toBe("gpt-image-1");
});

it("keeps model aliases and enabled choices when rotating a key at the same endpoint", async () => {
  const models = [
    {
      id: "alias",
      name: "Relay image",
      template: "gpt-image-1",
      enabled: true,
    },
  ];
  api.get.mockResolvedValue({
    ...initial,
    mode: "separate",
    configured: true,
    models,
  });
  await render();
  await clickLabel("Edit image API key");
  await fill("Image API key", "replacement-key");
  expect(container.textContent).toContain("Relay image");
  await save();
  expect(api.save).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "replacement-key", models }),
  );
  expect(api.discover).not.toHaveBeenCalled();
});
