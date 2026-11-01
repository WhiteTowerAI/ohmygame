// @vitest-environment happy-dom
import { act, StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Button,
  Combobox,
  CommandMenu,
  Dialog,
  DropdownMenu,
  Popover,
  SegmentedControl,
  Select,
  ToastProvider,
  Tooltip,
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
  vi.restoreAllMocks();
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

it("places a popover again when its content grows", async () => {
  const observed: Array<() => void> = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: () => void) {}
    observe() { observed.push(this.callback); }
    disconnect() {}
  });
  vi.stubGlobal("innerHeight", 600);
  function Example() {
    const anchor = useRef<HTMLButtonElement>(null);
    return <>
      <button ref={anchor} type="button">History</button>
      <Popover open onClose={() => {}} anchor={anchor} label="Conversations"><span>Rows</span></Popover>
    </>;
  }
  const rect = (top: number, height: number) => ({ x: 20, y: top, left: 20, top, right: 220, bottom: top + height, width: 200, height, toJSON: () => ({}) });
  vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue(rect(400, 28));
  const panelHeight = vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 100));
  await act(async () => root.render(<Example />));
  const panel = document.querySelector<HTMLElement>(".ui-popover")!;
  expect(panel.style.top).toBe("434px");
  // The archived view is taller than the room below the anchor, so the panel opens above it.
  panelHeight.mockReturnValue(rect(0, 300));
  await act(async () => observed.forEach((callback) => callback()));
  expect(panel.style.top).toBe("94px");
});

it("keeps a menu's icon column only when one of its items has an icon", async () => {
  const menu = (items: Parameters<typeof DropdownMenu>[0]["items"]) => act(async () => root.render(
    <DropdownMenu items={items} trigger={(props) => <button {...props} type="button">Open</button>} />,
  ));
  const open = () => act(async () => container.querySelector("button")!.click());
  await menu([{ label: "Make a maze" }, { label: "Make a racer" }]);
  await open();
  expect(document.querySelectorAll(".ui-menu-item")).toHaveLength(2);
  expect(document.querySelector(".ui-menu-icon")).toBeNull();
  await open();
  await menu([{ label: "Rename", icon: <svg /> }, { label: "Delete" }]);
  await open();
  // Labels still line up when only some items have icons.
  expect(document.querySelectorAll(".ui-menu-icon")).toHaveLength(2);
});

it("closes a popover on Escape and gives focus back to its anchor only from inside it", async () => {
  function Example() {
    const [open, setOpen] = useState(false);
    const anchor = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={anchor} type="button" onClick={() => setOpen(true)}>History</button>
        <input aria-label="Elsewhere" />
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Conversations">
          <input aria-label="Search" />
        </Popover>
      </>
    );
  }
  await act(async () => root.render(<Example />));
  const open = () => act(async () => container.querySelector("button")!.click());
  await open();
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search"]')!;
  search.focus();
  await key(search, "Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector("button"));
  await open();
  const elsewhere = container.querySelector<HTMLInputElement>('[aria-label="Elsewhere"]')!;
  elsewhere.focus();
  await key(elsewhere, "Escape");
  expect(document.activeElement).toBe(elsewhere);
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

it("tells screen readers a select's value and the option the keyboard is on", async () => {
  await act(async () =>
    root.render(
      <Select
        label="Size"
        value="medium"
        onChange={vi.fn()}
        options={[
          { value: "small", label: "Small" },
          { value: "medium", label: "Medium" },
          { value: "large", label: "Large" },
        ]}
      />,
    ),
  );
  const select = container.querySelector<HTMLButtonElement>(
    '[role="combobox"]',
  )!;
  const target = (attribute: string) =>
    document.getElementById(select.getAttribute(attribute)!);
  expect(target("aria-describedby")?.textContent).toBe("Medium");
  // Opening starts on the saved option; arrows move from there.
  await key(select, "ArrowDown");
  expect(target("aria-controls")?.getAttribute("role")).toBe("listbox");
  expect(target("aria-activedescendant")?.textContent).toBe("Medium");
  await key(select, "ArrowDown");
  expect(target("aria-activedescendant")?.textContent).toBe("Large");
});

it("scrolls the option the keyboard is on into view", async () => {
  // Each option is 60px tall in a popover that shows 100px.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const scroller = this.closest<HTMLElement>(".ui-popover");
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      const top = this.classList.contains("ui-popover")
        ? 0
        : index * 60 - (scroller?.scrollTop ?? 0);
      const height = this.classList.contains("ui-popover") ? 100 : 60;
      return { top, bottom: top + height } as DOMRect;
    },
  );
  await act(async () =>
    root.render(
      <Select
        label="Size"
        value="large"
        onChange={vi.fn()}
        options={[
          { value: "small", label: "Small" },
          { value: "medium", label: "Medium" },
          { value: "large", label: "Large" },
        ]}
      />,
    ),
  );
  const select = container.querySelector<HTMLButtonElement>(
    '[role="combobox"]',
  )!;
  await key(select, "ArrowDown");
  const popover = document.querySelector<HTMLElement>(".ui-popover")!;
  expect(popover.scrollTop).toBe(80);
  // Hovering a clipped option leaves the list where it is.
  const small = document.querySelector<HTMLElement>('[role="option"]')!;
  await act(async () =>
    small.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  expect(small.classList.contains("is-active")).toBe(true);
  expect(popover.scrollTop).toBe(80);
  // The keyboard scrolls again: Medium is 20px above the top.
  await key(select, "ArrowDown");
  expect(popover.scrollTop).toBe(60);
});

it("points a combobox at no list when nothing matches", async () => {
  await act(async () =>
    root.render(
      <Combobox
        label="Voice"
        onChange={vi.fn()}
        options={[{ value: "open", label: "Open" }]}
      />,
    ),
  );
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => input.focus());
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    set.call(input, "zzz");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelector(".ui-listbox-empty")).not.toBeNull();
  expect(input.getAttribute("aria-controls")).toBeNull();
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
});

it("waits before the first tooltip, then shows the next ones at once until the pointer rests", async () => {
  vi.useFakeTimers();
  await act(async () => root.render(<>
    <Tooltip content="Bold"><button type="button">B</button></Tooltip>
    <Tooltip content="Italic"><button type="button">I</button></Tooltip>
  </>));
  const [bold, italic] = [...container.querySelectorAll("button")];
  const tip = () => document.querySelector('[role="tooltip"]')?.textContent;
  const enter = (target: Element) => act(async () => { target.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
  const leave = (target: Element) => act(async () => { target.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })); });

  await enter(bold!);
  expect(tip()).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(350));
  expect(tip()).toBe("Bold");
  // Moving along the row shows the next one without the wait.
  await leave(bold!);
  await enter(italic!);
  expect(tip()).toBe("Italic");
  // After a rest, the wait comes back.
  await leave(italic!);
  await act(async () => vi.advanceTimersByTime(1_000));
  await enter(bold!);
  expect(tip()).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(350));
  expect(tip()).toBe("Bold");

  // A showing tooltip that goes away with its page warms the next one too.
  await act(async () => root.render(<Tooltip key="next" content="Italic"><button type="button">I</button></Tooltip>));
  expect(tip()).toBeUndefined();
  await enter(container.querySelector("button")!);
  expect(tip()).toBe("Italic");
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

it("filters commands under their headings and runs the one picked from the keyboard", async () => {
  const run = vi.fn();
  const onClose = vi.fn();
  const commands = [
    { id: "home", group: "Go to", label: "Home", run: () => run("home") },
    { id: "moon", group: "Projects", label: "Moon Garden", keywords: "web-game", run: () => run("moon") },
    { id: "night", group: "Projects", label: "Night Train", run: () => run("night") },
    { id: "theme", group: "Actions", label: "Switch theme", run: () => run("theme") },
  ];
  await act(async () => root.render(<CommandMenu open onClose={onClose} commands={commands} />));
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  expect(document.activeElement).toBe(input);
  const headings = () => [...document.querySelectorAll(".ui-command-heading")].map((heading) => heading.textContent);
  const options = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  expect(headings()).toEqual(["Go to", "Projects", "Actions"]);
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Keywords match too; the group's name does as well.
  await type("web");
  expect(options()).toEqual(["Moon Garden"]);
  await type("projects");
  expect(options()).toEqual(["Moon Garden", "Night Train"]);
  await key(input, "ArrowDown");
  expect(input.getAttribute("aria-activedescendant")).toBe(document.querySelectorAll('[role="option"]')[1]!.id);
  await key(input, "Enter", { isComposing: true });
  expect(run).not.toHaveBeenCalled();
  await key(input, "Enter");
  expect(onClose).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledExactlyOnceWith("night");
  await type("nothing here");
  expect(document.querySelector(".ui-command-empty")?.textContent).toContain("nothing here");
  // Escape mid-composition cancels the composition, not the menu.
  await key(input, "Escape", { isComposing: true });
  expect(onClose).toHaveBeenCalledOnce();
  await key(input, "Escape");
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("closes the command menu alone over a dialog, and gives focus back", async () => {
  const closeDialog = vi.fn();
  function Screen({ menu }: { menu: boolean }) {
    return (
      <Dialog open onClose={closeDialog} title="Provider">
        <input aria-label="Key" />
        <CommandMenu open={menu} onClose={() => {}} commands={[]} />
      </Dialog>
    );
  }
  // A dialog of the page's own that listens on the window, as the rename dialog does.
  const pageEscape = vi.fn((event: KeyboardEvent) => { if (event.key === "Escape") closeDialog(); });
  window.addEventListener("keydown", pageEscape);
  await act(async () => root.render(<Screen menu={false} />));
  const field = document.querySelector<HTMLInputElement>('[aria-label="Key"]')!;
  field.focus();
  await act(async () => root.render(<Screen menu />));
  expect(document.activeElement).toBe(document.querySelector('[role="combobox"]'));
  await key(document.activeElement!, "Escape");
  window.removeEventListener("keydown", pageEscape);
  expect(closeDialog).not.toHaveBeenCalled();
  await act(async () => root.render(<Screen menu={false} />));
  expect(document.activeElement).toBe(field);
  await key(field, "Escape");
  expect(closeDialog).toHaveBeenCalledOnce();
});

it("gives Escape to the dialog that holds focus, whichever opened last", async () => {
  const closed: string[] = [];
  const Pair = ({ outer, inner }: { outer: boolean; inner: boolean }) => (
    <StrictMode>
      {outer ? <Dialog open onClose={() => closed.push("outer")} title="Outer"><input aria-label="Outer field" /></Dialog> : null}
      <Dialog open={inner} onClose={() => closed.push("inner")} title="Inner"><input aria-label="Inner field" /></Dialog>
    </StrictMode>
  );
  await act(async () => root.render(<Pair outer={false} inner={false} />));
  // The outer dialog mounts as the inner one opens; StrictMode replays the new
  // one's effects, so the order they registered in says nothing about which is on top.
  await act(async () => root.render(<Pair outer inner />));
  const inner = document.querySelector<HTMLInputElement>('[aria-label="Inner field"]')!;
  inner.focus();
  await key(inner, "Escape");
  expect(closed).toEqual(["inner"]);
});
