// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Button,
  Combobox,
  Dialog,
  SegmentedControl,
  Select,
  ToastProvider,
  useToast,
} from "../src/renderer/ui/index.js";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function key(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

it("opens a dialog, closes it on Escape and returns focus", async () => {
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open</Button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Rename"
          footer={<Button variant="primary">Save</Button>}
        >
          <input aria-label="Name" />
        </Dialog>
      </>
    );
  }
  await act(async () => root.render(<Example />));
  const open = container.querySelector("button")!;
  open.focus();
  await act(async () => open.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.querySelector(".ui-dialog-title")?.textContent).toBe("Rename");
  expect(dialog.querySelector('[aria-label="Close"]')).not.toBeNull();
  expect(document.activeElement).toBe(
    dialog.querySelector('[aria-label="Name"]'),
  );
  await key(document, "Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(open);
});

it("keeps focus in the field being typed in when an inline onClose changes", async () => {
  function Example() {
    const [first, setFirst] = useState("");
    const [second, setSecond] = useState("");
    return (
      <Dialog open onClose={() => setFirst("")} title="Rename">
        <input aria-label="First" value={first} onChange={(event) => setFirst(event.target.value)} />
        <input aria-label="Second" value={second} onChange={(event) => setSecond(event.target.value)} />
      </Dialog>
    );
  }
  await act(async () => root.render(<Example />));
  const second = document.querySelector<HTMLInputElement>('[aria-label="Second"]')!;
  second.focus();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(second, "a");
    second.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(second.value).toBe("a");
  expect(document.activeElement).toBe(second);
});

it("skips disabled combobox options and ignores Enter while composing", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <Combobox
        label="Voice"
        onChange={onChange}
        options={[
          { value: "blocked", label: "Blocked", disabled: true },
          { value: "open", label: "Open" },
        ]}
      />,
    ),
  );
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  await key(input, "Enter", { isComposing: true, keyCode: 229 });
  expect(onChange).not.toHaveBeenCalled();
  await key(input, "Enter");
  expect(onChange).toHaveBeenCalledWith("open");
  expect(onChange).not.toHaveBeenCalledWith("blocked");
});

it("picks a segment and a select option from the keyboard", async () => {
  const onSegment = vi.fn();
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <>
        <SegmentedControl
          label="View"
          value="grid"
          onChange={onSegment}
          options={[
            { value: "grid", label: "Grid" },
            { value: "list", label: "List" },
          ]}
        />
        <Select
          label="Size"
          onChange={onSelect}
          options={[
            { value: "small", label: "Small" },
            { value: "large", label: "Large" },
          ]}
        />
      </>,
    ),
  );
  const segments = [...container.querySelectorAll('[role="radio"]')];
  expect(segments.map((item) => item.getAttribute("aria-checked"))).toEqual([
    "true",
    "false",
  ]);
  await act(async () => (segments[1] as HTMLButtonElement).click());
  expect(onSegment).toHaveBeenCalledWith("list");

  const select = container.querySelector<HTMLButtonElement>(
    '[aria-label="Size"]',
  )!;
  expect(select.textContent).toBe("Select…");
  await key(select, "ArrowDown");
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await key(select, "ArrowDown");
  await key(select, "ArrowDown");
  await key(select, "Enter");
  expect(onSelect).toHaveBeenCalledWith("large");
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it("shows a toast and removes it after a few seconds", async () => {
  vi.useFakeTimers();
  function Trigger() {
    const toast = useToast();
    return (
      <Button onClick={() => toast({ title: "Saved", tone: "success" })}>
        Save
      </Button>
    );
  }
  await act(async () =>
    root.render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(document.querySelector(".ui-toast-success")?.textContent).toBe(
    "Saved",
  );
  await act(async () => vi.advanceTimersByTime(4000));
  expect(document.querySelector(".ui-toast")).toBeNull();
});
