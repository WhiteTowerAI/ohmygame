// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Button,
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

function key(target: EventTarget, key: string) {
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
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
