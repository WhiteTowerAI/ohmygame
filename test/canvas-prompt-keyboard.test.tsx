// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AgentModel } from "../src/shared/contracts.js";
import {
  CanvasTextarea,
  CanvasTextComposer,
} from "../src/renderer/canvas-text-composer.js";
import { VideoReferencePrompt } from "../src/renderer/video-reference-prompt.js";

const model: AgentModel = {
  provider: "test",
  providerName: "Test",
  id: "test",
  name: "Test",
  reasoningLevels: ["off", "medium"],
};
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(element: ReactNode) {
  await act(async () => root.render(element));
}
async function enter(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(async () => host.querySelector("textarea")!.dispatchEvent(event));
  return event;
}
function Composer({
  onGenerate,
  ...options
}: {
  onGenerate: () => void;
  busy?: boolean;
  generating?: boolean;
  instruction?: string;
  models?: AgentModel[];
}) {
  return (
    <CanvasTextComposer
      models={[model]}
      modelStatus="ready"
      defaultModel={model}
      instruction="Write a scene"
      onInstruction={() => {}}
      onModel={() => {}}
      onReasoningChange={() => {}}
      onGenerate={onGenerate}
      {...options}
    />
  );
}
it("uses the same generation action for Enter and the button, leaving Shift+Enter to the browser", async () => {
  const generate = vi.fn();
  await render(<Composer onGenerate={generate} />);
  expect((await enter({ shiftKey: true })).defaultPrevented).toBe(false);
  expect(generate).not.toHaveBeenCalled();
  expect((await enter()).defaultPrevented).toBe(true);
  expect(generate).toHaveBeenCalledWith(
    { provider: "test", id: "test" },
    "medium",
  );
  expect((await enter({ repeat: true })).defaultPrevented).toBe(true);
  expect(generate).toHaveBeenCalledTimes(1);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Generate text"]')!
      .click(),
  );
  expect(generate).toHaveBeenCalledTimes(2);
});
it.each([
  { busy: true },
  { generating: true },
  { instruction: "  " },
  { models: [] },
])("does not generate while unavailable: %j", async (options) => {
  const generate = vi.fn();
  await render(<Composer onGenerate={generate} {...options} />);
  await enter();
  expect(generate).not.toHaveBeenCalled();
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Generate text"]')!
      .disabled,
  ).toBe(true);
});
it("lets IME confirm text before a later Enter can submit", async () => {
  const generate = vi.fn();
  await render(<Composer onGenerate={generate} />);
  const input = host.querySelector("textarea")!;
  await act(async () =>
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    ),
  );
  expect((await enter()).defaultPrevented).toBe(false);
  expect(generate).not.toHaveBeenCalled();
  await act(async () =>
    input.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    ),
  );
  await enter({ isComposing: true });
  await enter({ keyCode: 229 });
  expect(generate).not.toHaveBeenCalled();
  await enter();
  expect(generate).toHaveBeenCalledTimes(1);
});
it("keeps ordinary canvas content multiline and respects an earlier keyboard handler", async () => {
  const submit = vi.fn();
  await render(<CanvasTextarea value="Document content" onChange={() => {}} />);
  expect((await enter()).defaultPrevented).toBe(false);
  await render(
    <CanvasTextarea
      value="Prompt"
      onChange={() => {}}
      onSubmit={submit}
      onKeyDown={(event) => event.preventDefault()}
    />,
  );
  await enter();
  expect(submit).not.toHaveBeenCalled();
});
it("selects video references before submitting and allows Shift+Enter inside the suggestion menu", async () => {
  const submit = vi.fn();
  function VideoPrompt() {
    const [value, setValue] = useState("@");
    return (
      <VideoReferencePrompt
        value={value}
        options={[{ alias: "Image1", name: "Reference" }]}
        onChange={setValue}
        onSubmit={submit}
      />
    );
  }
  await render(<VideoPrompt />);
  const input = host.querySelector("textarea")!;
  await act(async () => {
    input.focus();
    input.setSelectionRange(1, 1);
    input.dispatchEvent(
      new KeyboardEvent("keyup", { key: "@", bubbles: true }),
    );
  });
  expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  expect((await enter({ shiftKey: true })).defaultPrevented).toBe(false);
  await enter({ isComposing: true });
  await enter({ keyCode: 229 });
  expect(submit).not.toHaveBeenCalled();
  expect(input.value).toBe("@");
  expect((await enter()).defaultPrevented).toBe(true);
  expect(input.value).toBe("@Image1 ");
  expect(submit).not.toHaveBeenCalled();
  await enter();
  expect(submit).toHaveBeenCalledTimes(1);
});


it("keeps the prompt and settings when expanded, traps focus and restores the expand button", async () => {
  const generate = vi.fn();
  function Editable() {
    const [instruction, setInstruction] = useState("Long prompt draft");
    return <CanvasTextComposer models={[model]} modelStatus="ready" defaultModel={model} instruction={instruction}
      onInstruction={setInstruction} onModel={() => {}} onReasoningChange={() => {}} onGenerate={generate} />;
  }
  await render(<Editable />);
  const expand = host.querySelector<HTMLButtonElement>('[aria-label="Expand prompt editor"]')!;
  await act(async () => expand.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Prompt editor"]')!;
  const input = dialog.querySelector("textarea")!;
  expect(input.value).toBe("Long prompt draft");
  expect(document.activeElement).toBe(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "Edited expanded draft"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(dialog.querySelector('[aria-label="Generate text"]')).not.toBeNull();
  const boardKey = vi.fn();
  document.addEventListener("keydown", boardKey);
  await act(async () => dialog.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
  document.removeEventListener("keydown", boardKey);
  expect(boardKey).not.toHaveBeenCalled();
  const last = dialog.querySelector<HTMLButtonElement>('[aria-label="Generate text"]')!;
  last.focus();
  await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(dialog.querySelector("button"));
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"][aria-label="Prompt editor"]')).toBeNull();
  expect(host.querySelector("textarea")!.value).toBe("Edited expanded draft");
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Expand prompt editor"]'));
  expect(generate).not.toHaveBeenCalled();
});
