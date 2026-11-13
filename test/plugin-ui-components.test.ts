// @vitest-environment happy-dom
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { Blob as NodeBlob } from "node:buffer";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComponentManifest, componentManifest, componentTypes, contractChanges, contractFiles, declarations, parseComment, supportChanges } from "../scripts/plugin-ui-contract.js";
import { checkFolder, checkPlugin } from "../scripts/plugin-check.js";
import { compareRuns } from "../scripts/plugin-ui-regression.js";
import { validatePluginManifest } from "../src/shared/plugin-manifest.js";
import { PLUGIN_UI_MAJORS } from "../src/shared/plugin-ui-versions.js";

// The components load as the app serves them, next to the bridge at
// /_ohmygame/plugin-ui.js, so they are copied into that layout first, in the
// project's ignored .runtime folder, where the test's module loader reaches.
let served: string;
let calls: { method: string; params?: Record<string, unknown> }[];
let answer: (id: number, method: string, params?: Record<string, unknown>) => void;
let app: MessagePort;

beforeAll(async () => {
  // happy-dom has no top layer. Exercise component state here; the Electron
  // panel regression and interactive browser checks cover native placement.
  HTMLElement.prototype.showPopover = function () {};
  HTMLElement.prototype.hidePopover = function () {};

  await mkdir(".runtime", { recursive: true });
  served = await realpath(await mkdtemp(path.join(".runtime", "test-ui-")));
  await mkdir(path.join(served, "_ohmygame"));
  await cp("packages/plugin-ui/index.js", path.join(served, "_ohmygame/plugin-ui.js"));
  await cp("packages/plugin-ui/ui", path.join(served, "_ohmygame/ui"), { recursive: true });
  // As in a page, the components load before the app sends its port.
  await import(/* @vite-ignore */ path.join(served, "_ohmygame/ui/1/index.js"));
  const channel = new MessageChannel();
  app = channel.port1;
  app.onmessage = ({ data }) => {
    if (typeof data?.id !== "number") return;
    calls.push({ method: data.method, ...(data.params ? { params: data.params } : {}) });
    answer(data.id, data.method, data.params);
  };
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { type: "ohmygame-plugin-ui", plugin: { id: "acme/panel", version: "1.0.0", panel: "main" }, locale: "en" },
      ports: [channel.port2 as never],
    }),
  );
});
afterAll(async () => {
  app.close();
  await rm(served, { recursive: true, force: true });
});
beforeEach(() => {
  document.body.replaceChildren();
  calls = [];
  answer = (id) => app.postMessage({ id, result: { ok: true } });
});

const shadow = (element: Element, part: string) =>
  element.shadowRoot!.querySelector<HTMLElement>(`[part~="${part}"]`)!;
const html = <T extends HTMLElement = HTMLElement>(markup: string): T => {
  document.body.innerHTML = markup;
  return document.body.firstElementChild as T;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("page components", () => {
  it("distinguishes pointer focus from keyboard navigation across form controls", async () => {
    const wrapper = html(`<div><omg-input label="Name"></omg-input><omg-textarea label="Description"></omg-textarea><omg-select label="Channel"><option>Draft</option></omg-select><omg-combobox label="Project"><option>Garden</option></omg-combobox><omg-file-picker label="File"></omg-file-picker><omg-slider label="Volume" value="50"></omg-slider><omg-radio-group label="Quality"><option>Draft</option></omg-radio-group><omg-checkbox label="Compress"></omg-checkbox><omg-switch label="Auto upload"></omg-switch><omg-segmented label="Target"><option value="web">Web</option><option value="pc">Desktop</option></omg-segmented><button>Outside</button></div>`);
    await settle();
    for (const field of [...wrapper.children].filter((node) => node.localName.startsWith("omg-"))) {
      const surface = shadow(field, "field");
      const control = field.shadowRoot!.querySelector<HTMLElement>("input, textarea, select")!;
      control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
      control.focus();
      expect(surface.classList.contains("pointer-focus"), field.localName).toBe(true);
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(surface.classList.contains("pointer-focus"), "typing does not reinstate a clicked ring").toBe(true);
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      expect(surface.classList.contains("pointer-focus"), field.localName).toBe(false);
      control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
      wrapper.querySelector("button")!.focus();
      await settle();
      expect(surface.classList.contains("pointer-focus"), "pointer state clears when leaving the field").toBe(false);
    }
  });

  it("keeps local file selection across rejection, cancel, disable and reconnect", () => {
    const picker = html(`<omg-file-picker label="Image" accept=".png,image/jpeg" rejected-label="Choose one image"></omg-file-picker>`) as HTMLElement & { files: File[]; clear(): void };
    const input = shadow(picker, "input") as HTMLInputElement;
    const zone = shadow(picker, "dropzone");
    const png = new File(["pixels"], "game.png", { type: "image/png" });
    const jpeg = new File(["pixels"], "game.jpg", { type: "image/jpeg" });
    const text = new File(["text"], "note.txt", { type: "text/plain" });
    const heard: string[][] = [];
    const rejected: string[] = [];
    const events: string[] = [];
    picker.addEventListener("input", () => events.push("input"));
    picker.addEventListener("change", () => { events.push("change"); heard.push(picker.files.map((file) => file.name)); });
    picker.addEventListener("omg-reject", (event) => rejected.push((event as CustomEvent).detail.reason));
    const drop = (files: File[]) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files } });
      zone.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    drop([png]);
    expect(picker.files).toEqual([png]);
    expect(heard).toEqual([["game.png"]]);
    expect(events).toEqual(["input", "change"]);
    picker.files.pop();
    expect(picker.files).toEqual([png]); // callers cannot mutate selection through the getter
    drop([text]);
    drop([png, jpeg]);
    expect(rejected).toEqual(["accept", "multiple"]);
    expect(picker.files).toEqual([png]);
    expect(shadow(picker, "error").textContent).toBe("Choose one image");
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    input.dispatchEvent(new Event("change", { bubbles: true })); // chooser cancelled
    expect(picker.files).toEqual([png]);
    picker.setAttribute("disabled", "");
    drop([jpeg]);
    expect(input.disabled).toBe(true);
    expect(picker.files).toEqual([png]);
    picker.removeAttribute("disabled");
    picker.setAttribute("multiple", "");
    drop([png, jpeg]);
    expect(picker.files).toEqual([png, jpeg]);
    expect(shadow(picker, "error").hidden).toBe(true);
    picker.remove();
    document.body.append(picker);
    expect(picker.files).toEqual([png, jpeg]);
    shadow(picker, "clear").click();
    expect(heard.at(-1)).toEqual([]);
    expect(picker.files).toEqual([]);
    Object.defineProperty(input, "files", { configurable: true, value: [png] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const count = heard.length;
    picker.clear();
    expect(picker.files).toEqual([]);
    expect(heard).toHaveLength(count); // programmatic clear is silent
    input.blur();
  });

  it("keeps dialog edits mounted, allows cancelling dismissal and restores the opener", async () => {
    const wrapper = html(`<div><button>Open</button><omg-dialog heading="Import" description="Review files"><omg-input label="Folder" value="assets"></omg-input><button slot="footer">Done</button></omg-dialog></div>`);
    const dialog = wrapper.querySelector("omg-dialog")! as HTMLElement & { open: boolean };
    const panel = shadow(dialog, "panel") as HTMLDialogElement;
    const opener = wrapper.querySelector("button")!;
    const input = shadow(dialog.querySelector("omg-input")!, "input") as HTMLInputElement;
    opener.focus();
    dialog.open = true;
    expect(panel.open).toBe(true);
    expect(panel.getAttribute("aria-describedby")).toBe("description");
    input.value = "textures";
    const reasons: string[] = [];
    const prevent = (event: Event) => { reasons.push((event as CustomEvent).detail.reason); event.preventDefault(); };
    dialog.addEventListener("omg-close", prevent);
    panel.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(dialog.open).toBe(true);
    expect(reasons).toEqual(["escape"]);
    dialog.removeEventListener("omg-close", prevent);
    input.focus();
    shadow(dialog, "close").click();
    expect(dialog.open).toBe(false);
    expect(panel.open).toBe(false);
    expect(document.activeElement).toBe(opener);
    dialog.open = true;
    expect(input.value).toBe("textures");
    dialog.open = false;
    dialog.open = true;
    panel.dispatchEvent(new Event("close")); // stale queued close after reopening
    expect(dialog.open).toBe(true);
    dialog.remove();
    expect(panel.open).toBe(false);
    wrapper.append(dialog);
    expect(panel.open).toBe(true);
    dialog.open = false;
    opener.focus();
    await settle();
  });

  it("dismisses only the topmost popover and preserves content, focus and listener lifetimes", () => {
    const wrapper = html(`<div><omg-popover label="Outer"><input value="dist"><omg-popover label="Inner"><input></omg-popover></omg-popover><button>Outside</button></div>`);
    const [outer, inner] = [...wrapper.querySelectorAll("omg-popover")] as (HTMLElement & { open: boolean })[];
    const outside = wrapper.querySelector("button")!;
    const field = outer!.querySelector("input")!;
    shadow(outer!, "button").click();
    expect(outer!.open).toBe(true);
    expect(outer!.shadowRoot!.activeElement).toBe(shadow(outer!, "panel"));
    field.value = "custom-dist";
    shadow(inner!, "button").click();
    inner!.querySelector("input")!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(inner!.open).toBe(false);
    expect(outer!.open).toBe(true);
    expect(inner!.shadowRoot!.activeElement).toBe(shadow(inner!, "button"));
    outside.focus();
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    expect(outer!.open).toBe(false);
    expect(document.activeElement).toBe(outside);
    outer!.open = true;
    expect(field.value).toBe("custom-dist");
    wrapper.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(outer!.open).toBe(true); // detached instances have no global listeners
    document.body.append(wrapper);
    expect(shadow(outer!, "panel").hidden).toBe(false);
    outer!.setAttribute("disabled", "");
    expect(outer!.open).toBe(false);
  });

  it("keeps a popover open through transient focusout before a slotted control receives focus", async () => {
    const wrapper = html(`<div><omg-popover label="Build settings"><omg-stack><omg-input label="Folder" value="dist"></omg-input><omg-checkbox label="Maps"></omg-checkbox></omg-stack></omg-popover><button>Outside</button></div>`);
    const popover = wrapper.querySelector("omg-popover")! as HTMLElement & { open: boolean };
    shadow(popover, "button").click();
    // Native pointer focusing can briefly report body, with a microtask before
    // focusin reaches the destination. The previous focusout check closed here.
    shadow(popover, "panel").blur();
    await Promise.resolve();
    expect(popover.open).toBe(true);
    const input = shadow(popover.querySelector("omg-input")!, "input") as HTMLInputElement;
    input.focus();
    input.value = "web-export";
    shadow(popover.querySelector("omg-checkbox")!, "checkbox").focus();
    expect(popover.open).toBe(true);
    wrapper.querySelector("button")!.focus();
    expect(popover.open).toBe(false);
    shadow(popover, "button").click();
    expect(input.value).toBe("web-export");
    // Flush field cleanup with document focus; happy-dom cannot query a
    // shadow root's activeElement while a sibling shadow root owns focus.
    wrapper.querySelector("button")!.focus();
    await settle();
  });

  it("navigates menu actions, skips disabled items and returns focus after selection", () => {
    const menu = html(`<omg-menu label="Actions"></omg-menu>`) as HTMLElement & { open: boolean; items: { value: string; label: string; disabled?: boolean; checked?: boolean }[] };
    menu.items = [{ value: "a", label: "Alpha" }, { value: "b", label: "Blocked", disabled: true }, { value: "c", label: "Copy", checked: true }];
    const selected: string[] = [];
    menu.addEventListener("omg-select", (event) => selected.push((event as CustomEvent).detail.value));
    const trigger = shadow(menu, "button");
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(menu.shadowRoot!.activeElement?.textContent).toBe("Alpha");
    const panel = shadow(menu, "panel");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(menu.shadowRoot!.activeElement?.getAttribute("aria-checked")).toBe("true");
    menu.items = [...menu.items, { value: "d", label: "Delete" }];
    expect((menu.shadowRoot!.activeElement as HTMLElement).dataset.value).toBe("c");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    (menu.shadowRoot!.activeElement as HTMLElement).click();
    expect(selected).toEqual(["d"]);
    expect(menu.open).toBe(false);
    expect(menu.shadowRoot!.activeElement).toBe(trigger);
    trigger.click();
    (panel.querySelector("button:disabled") as HTMLButtonElement).click();
    expect(selected).toEqual(["d"]);
  });

  it("shows tooltip on focus and delayed hover, restoring existing descriptions on cleanup", async () => {
    const tooltip = html(`<omg-tooltip content="Remote status"><omg-button>Refresh</omg-button></omg-tooltip>`);
    const button = shadow(tooltip.querySelector("omg-button")!, "button");
    button.setAttribute("aria-description", "Existing hint");
    button.focus();
    expect(shadow(tooltip, "tooltip").hidden).toBe(false);
    expect(button.getAttribute("aria-description")).toBe("Existing hint. Remote status");
    tooltip.setAttribute("content", "Updated hint");
    expect(button.getAttribute("aria-description")).toBe("Existing hint. Updated hint");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shadow(tooltip, "tooltip").hidden).toBe(true);
    tooltip.remove();
    expect(button.getAttribute("aria-description")).toBe("Existing hint");
    await new Promise((resolve) => setTimeout(resolve, 310));
    document.body.append(tooltip);
    tooltip.dispatchEvent(new PointerEvent("pointerenter"));
    expect(shadow(tooltip, "tooltip").hidden).toBe(true);
    tooltip.dispatchEvent(new PointerEvent("pointerleave"));
    await new Promise((resolve) => setTimeout(resolve, 370));
    expect(shadow(tooltip, "tooltip").hidden).toBe(true);
  });

  it("keeps combobox search separate from selection and handles async, disabled and empty choices", async () => {
    const box = html(`<omg-combobox label="Project" value="a"><option value="a">Alpha</option><option value="b" disabled>Blocked</option><option value="c">Copy</option></omg-combobox>`) as HTMLElement & { value: string; query: string };
    const input = shadow(box, "input") as HTMLInputElement;
    const queries: string[] = [];
    const values: string[] = [];
    box.addEventListener("omg-query", (event) => queries.push((event as CustomEvent).detail.query));
    box.addEventListener("change", () => values.push(box.value));
    await settle();
    expect(input.value).toBe("Alpha");
    input.focus();
    input.value = "co";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(queries).toEqual(["co"]);
    // Committing the native search text must not announce a selected value.
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(box.value).toBe("a");
    expect(values).toEqual([]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(box.value).toBe("c");
    expect(input.value).toBe("Copy");
    expect(values).toEqual(["c"]);
    input.click();
    input.value = "missing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(shadow(box, "status").textContent).toBe("No results");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("Copy");
    expect(box.query).toBe("");
    box.setAttribute("manual-filter", "");
    input.click();
    expect(queries.at(-1)).toBe(""); // reopening remote search requests the unfiltered list
    box.setAttribute("loading", "");
    expect(shadow(box, "options").children).toHaveLength(0);
    box.innerHTML = `<option value="c">Copy renamed</option><option value="d" disabled>Disabled</option>`;
    await settle();
    box.removeAttribute("loading");
    expect(box.value).toBe("c");
    (shadow(box, "options").children[1] as HTMLElement).click();
    expect(values).toEqual(["c"]);
    box.setAttribute("disabled", "");
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("Copy renamed");
    box.innerHTML = `<option value="e">Elsewhere</option>`;
    await settle();
    expect(input.value).toBe("Copy renamed"); // async pages may omit the selected option
    box.remove();
    document.body.append(box);
    expect(box.value).toBe("c");
  });

  it("retains keyed table cells, text safety, focus and scroll position when data refreshes", () => {
    const table = html(`<omg-table label="Versions"></omg-table>`) as HTMLElement & { columns: { key: string; heading: string }[]; rows: { key: string; cells: Record<string, string | Node> }[] };
    const input = document.createElement("input");
    input.value = "draft";
    table.columns = [{ key: "name", heading: "Version" }, { key: "edit", heading: "Edit" }];
    table.rows = [{ key: "1", cells: { name: "<img onerror=alert(1)>", edit: input } }];
    expect(table.shadowRoot!.querySelector("img")).toBeNull();
    expect(table.shadowRoot!.querySelector("td")!.textContent).toContain("<img");
    input.focus();
    input.value = "unsaved";
    shadow(table, "region").scrollLeft = 70;
    const row = table.shadowRoot!.querySelector("tbody tr");
    table.rows = [{ key: "1", cells: { name: "Updated", edit: input } }];
    expect(table.shadowRoot!.querySelector("tbody tr")).toBe(row);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("unsaved");
    expect(shadow(table, "region").scrollLeft).toBe(70);
    table.setAttribute("loading", "");
    expect(shadow(table, "table").getAttribute("aria-busy")).toBe("true");
    table.rows = [];
    table.removeAttribute("loading");
    expect(input.isConnected).toBe(false);
    expect(shadow(table, "empty").hidden).toBe(false);
  });

  it("requests pagination without optimistic page changes and preserves focus while pending", () => {
    const pagination = html(`<omg-pagination page="1" pages="3" previous-label="上一页" next-label="下一页"></omg-pagination>`);
    const requested: number[] = [];
    pagination.addEventListener("omg-page-change", (event) => requested.push((event as CustomEvent).detail.page));
    shadow(pagination, "previous").click();
    const next = shadow(pagination, "next");
    next.focus();
    next.click();
    expect(requested).toEqual([2]);
    expect(shadow(pagination, "status").textContent).toBe("1 / 3");
    pagination.setAttribute("disabled", "");
    next.click();
    expect(requested).toEqual([2]);
    expect(pagination.shadowRoot!.activeElement).toBe(next);
    pagination.removeAttribute("disabled"); // failed request: same target can be retried
    next.click();
    expect(requested).toEqual([2, 2]);
    pagination.setAttribute("page", "3");
    next.click();
    expect(requested).toEqual([2, 2]);
    expect(next.getAttribute("aria-disabled")).toBe("true");
  });

  it("toggles disclosure content without replacing it, and only reports user activation", () => {
    const disclosure = html(`<omg-disclosure heading="Options"><input value="dist"><button>Inside</button></omg-disclosure>`) as HTMLElement & { open: boolean; disabled: boolean };
    const trigger = shadow(disclosure, "button") as HTMLButtonElement;
    const body = shadow(disclosure, "body");
    const input = disclosure.querySelector("input")!;
    const heard: boolean[] = [];
    disclosure.addEventListener("omg-toggle", (event) => heard.push((event as CustomEvent<{ open: boolean }>).detail.open));
    expect(trigger.type).toBe("button");
    expect(trigger.getAttribute("aria-controls")).toBe(body.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);

    trigger.click();
    expect(disclosure.open).toBe(true);
    expect(body.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    input.value = "web-export";
    disclosure.querySelector("button")!.click();
    expect(disclosure.open).toBe(true);
    trigger.click();
    expect(body.hidden).toBe(true);
    expect(heard).toEqual([true, false]);

    disclosure.open = true;
    disclosure.setAttribute("heading", "Export options");
    expect(shadow(disclosure, "heading").textContent).toBe("Export options");
    disclosure.disabled = true;
    expect(trigger.disabled).toBe(true);
    trigger.click();
    expect(disclosure.open).toBe(true);
    disclosure.remove();
    disclosure.open = false;
    document.body.append(disclosure);
    expect(body.hidden).toBe(true);
    disclosure.disabled = false;
    trigger.click();
    expect(heard).toEqual([true, false, true]);
    expect(disclosure.querySelector("input")).toBe(input);
    expect(input.value).toBe("web-export");
  });

  it("restores focus when closing a disclosure from inside, without stealing outside focus", () => {
    const parent = html(`<div><omg-disclosure heading="Outer" open><omg-disclosure heading="Inner" open><input></omg-disclosure></omg-disclosure><button>Outside</button></div>`);
    const outer = parent.querySelector("omg-disclosure")! as HTMLElement & { open: boolean };
    const inner = outer.querySelector("omg-disclosure")!;
    const input = inner.querySelector("input")!;
    const outside = parent.querySelector("button")!;
    const events: Event[] = [];
    parent.addEventListener("omg-toggle", (event) => events.push(event));
    input.focus();
    outer.open = false;
    expect(outer.shadowRoot!.activeElement).toBe(shadow(outer, "button"));
    outer.open = true;
    outside.focus();
    outer.open = false;
    expect(document.activeElement).toBe(outside);
    expect(events).toEqual([]);
    outer.open = true;
    shadow(inner, "button").click();
    expect(outer.open).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.target).toBe(inner);
    expect(events[0]!.composed).toBe(true);
  });

  it("lays out a page and sections, hiding headers with nothing in them", async () => {
    const page = html(`<omg-page heading="TapTap Maker"><omg-section heading="Preview"><p>Body</p></omg-section><omg-section></omg-section></omg-page>`);
    await settle();
    expect(shadow(page, "heading").textContent).toBe("TapTap Maker");
    expect(shadow(page, "description").hidden).toBe(true);
    const [titled, bare] = page.querySelectorAll("omg-section");
    expect(shadow(titled!, "section").getAttribute("aria-labelledby")).toBe("heading");
    expect(shadow(bare!, "header").hidden).toBe(true);
    expect(shadow(bare!, "section").hasAttribute("aria-labelledby")).toBe(false);
  });

  it("opens one tab at a time, by click, by keys and by value, skipping disabled tabs", async () => {
    const tabs = html(`<omg-tabs aria-label="Views">
      <omg-tab name="a" heading="A"></omg-tab><omg-tab name="b" heading="B" disabled></omg-tab><omg-tab name="c" heading="C"></omg-tab>
    </omg-tabs>`) as HTMLElement & { value: string };
    await settle();
    const list = shadow(tabs, "list");
    const buttons = () => [...list.querySelectorAll("button")];
    const open = () => [...tabs.querySelectorAll("omg-tab")].filter((tab) => !(tab as HTMLElement).hidden).map((tab) => tab.getAttribute("name"));
    expect(list.getAttribute("aria-label")).toBe("Views");
    expect(buttons().map((button) => button.textContent)).toEqual(["A", "B", "C"]);
    expect(buttons().map((button) => button.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(buttons().map((button) => button.tabIndex)).toEqual([0, -1, -1]);
    expect(open()).toEqual(["a"]);
    expect(tabs.querySelector("omg-tab")!.getAttribute("role")).toBe("tabpanel");
    expect(tabs.querySelector("omg-tab")!.getAttribute("aria-label")).toBe("A");

    const heard: string[] = [];
    tabs.addEventListener("omg-tab-change", (event) => heard.push((event as CustomEvent<{ value: string }>).detail.value));
    buttons()[0]!.focus();
    buttons()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true }));
    expect(tabs.value).toBe("c");
    expect(open()).toEqual(["c"]);
    expect(tabs.shadowRoot!.activeElement?.textContent).toBe("C");
    buttons()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true }));
    expect(tabs.value).toBe("a");
    buttons()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, composed: true }));
    expect(tabs.value).toBe("c");
    buttons()[0]!.click();
    expect(tabs.value).toBe("a");
    buttons()[0]!.click();
    expect(heard).toEqual(["c", "a", "c", "a"]);

    tabs.value = "c";
    expect(open()).toEqual(["c"]);
    expect(heard).toHaveLength(4);
    tabs.value = "b";
    expect(open()).toEqual(["a"]);

    tabs.insertAdjacentHTML("beforeend", `<omg-tab name="d" heading="D"></omg-tab>`);
    tabs.querySelector("omg-tab")!.setAttribute("heading", "First");
    await settle();
    expect(buttons().map((button) => button.textContent)).toEqual(["First", "B", "C", "D"]);

    // The focused tab goes away: focus moves to the tab that opens instead.
    tabs.value = "d";
    buttons()[3]!.focus();
    tabs.querySelector('omg-tab[name="d"]')!.setAttribute("disabled", "");
    await settle();
    expect(tabs.value).toBe("a");
    expect(tabs.shadowRoot!.activeElement?.textContent).toBe("First");
  });

  it("arranges a grid and a split by their attributes, and hides a list item's empty places", async () => {
    const grid = html(`<omg-grid min="180"></omg-grid>`);
    expect(shadow(grid, "grid").style.getPropertyValue("--_columns")).toContain("180px");
    grid.setAttribute("columns", "3");
    expect(shadow(grid, "grid").style.getPropertyValue("--_columns")).toBe("repeat(3, minmax(0, 1fr))");
    grid.setAttribute("columns", "nope");
    grid.setAttribute("min", "-1");
    expect(shadow(grid, "grid").style.getPropertyValue("--_columns")).toContain("240px");

    const split = html(`<omg-split side-width="300"></omg-split>`);
    expect(shadow(split, "split").style.getPropertyValue("--_side")).toBe("300px");

    const list = html(`<omg-list><omg-list-item heading="Account"></omg-list-item><omg-list-item heading="Project" description="Connected">Zombie farm<omg-button slot="actions">Change</omg-button></omg-list-item></omg-list>`);
    await settle();
    expect(list.getAttribute("role")).toBe("list");
    const [bare, full] = list.querySelectorAll("omg-list-item");
    expect(bare!.getAttribute("role")).toBe("listitem");
    for (const place of ["leading", "description", "value", "actions"]) expect(shadow(bare!, place).hidden).toBe(true);
    for (const place of ["description", "value", "actions"]) expect(shadow(full!, place).hidden).toBe(false);

    const card = html(`<omg-card></omg-card>`);
    await settle();
    expect(shadow(card, "header").hidden).toBe(true);
    expect(shadow(card, "body").hidden).toBe(true);

    // A text node's words changing tells no slot; the place shows all the same.
    const late = html(`<omg-card> </omg-card>`);
    await settle();
    expect(shadow(late, "body").hidden).toBe(true);
    (late.firstChild as Text).data = "Loaded";
    await settle();
    expect(shadow(late, "body").hidden).toBe(false);
    const row = html(`<omg-list-item> </omg-list-item>`);
    await settle();
    (row.firstChild as Text).data = "Loaded";
    await settle();
    expect(shadow(row, "value").hidden).toBe(false);

    const divider = html(`<omg-divider></omg-divider>`);
    expect(divider.getAttribute("role")).toBe("separator");
    expect(shadow(divider, "label").hidden).toBe(true);
  });

  it("numbers steps and shows only the current or failed step's content", async () => {
    const steps = html(`<omg-steps>
      <omg-step heading="Prepare" state="done"><span slot="summary">Ready</span><p>Prepare body</p></omg-step>
      <omg-step heading="Sign in" state="current"><p>Sign-in body</p></omg-step>
      <omg-step heading="Connect"><p>Connect body</p></omg-step>
    </omg-steps>`);
    await settle();
    const [done, current, pending] = steps.querySelectorAll("omg-step");
    expect(steps.getAttribute("role")).toBe("list");
    expect(shadow(done!, "marker").querySelector("svg")).not.toBeNull();
    expect(shadow(done!, "summary").hidden).toBe(false);
    expect(shadow(done!, "body").hidden).toBe(true);
    expect(current!.getAttribute("aria-current")).toBe("step");
    expect(shadow(current!, "body").hidden).toBe(false);
    expect(shadow(pending!, "marker").textContent).toBe("3");
    expect(shadow(pending!, "body").hidden).toBe(true);
    pending!.setAttribute("state", "error");
    expect(shadow(pending!, "marker").textContent).toBe("!");
    expect(shadow(pending!, "body").hidden).toBe(false);
  });

  it("makes statuses and banners live regions and shows a busy spinner", () => {
    const status = html(`<omg-status tone="good">Running</omg-status>`);
    expect(status.getAttribute("role")).toBe("status");
    expect(shadow(status, "spinner").hidden).toBe(true);
    status.setAttribute("tone", "busy");
    expect(shadow(status, "spinner").hidden).toBe(false);
    const banner = html(`<omg-banner tone="warning" heading="Python missing">Install Python 3.8</omg-banner>`);
    expect(banner.getAttribute("role")).toBe("status");
    banner.setAttribute("tone", "bad");
    expect(banner.getAttribute("role")).toBe("alert");
    const chosen = html(`<omg-banner tone="bad" role="note">Kept</omg-banner>`);
    expect(chosen.getAttribute("role")).toBe("note");
  });

  it("shows a log's lines, or its empty text", async () => {
    const log = html<HTMLElement & { text: string }>(`<omg-log empty="No log lines yet."></omg-log>`);
    expect(shadow(log, "log").hidden).toBe(true);
    expect(shadow(log, "empty").textContent).toBe("No log lines yet.");
    log.text = "started\nready";
    await settle();
    expect(shadow(log, "log").hidden).toBe(false);
    expect(shadow(log, "empty").hidden).toBe(true);
  });

  it("copies a select's options and keeps its value", async () => {
    const select = html<HTMLElement & { value: string }>(`<omg-select label="Project" value="b"><option value="a">Alpha</option><option value="b">Beta</option></omg-select>`);
    const native = shadow(select, "select") as HTMLSelectElement;
    // A parser may attach the select before its options.
    await settle();
    expect([...native.options].map((option) => option.textContent)).toEqual(["Alpha", "Beta"]);
    expect(select.value).toBe("b");
    const changes: string[] = [];
    select.addEventListener("change", () => changes.push(select.value));
    native.value = "a";
    native.dispatchEvent(new Event("change"));
    expect(changes).toEqual(["a"]);
    select.insertAdjacentHTML("beforeend", `<option value="c">Gamma</option>`);
    await settle();
    expect([...native.options].map((option) => option.value)).toEqual(["a", "b", "c"]);
    expect(select.value).toBe("a");
    // `input` already crosses the shadow boundary; it arrives once.
    const inputs: Event[] = [];
    select.addEventListener("input", (event) => inputs.push(event));
    native.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(inputs).toHaveLength(1);
    // As a native select, a value no option has leaves nothing chosen.
    select.value = "missing";
    expect(select.value).toBe("");
  });

  it("gives a control its label, a hint, or an error in the hint's place", async () => {
    const input = html(`<omg-input label="Name" hint="Shown publicly." placeholder="Zombie farm"></omg-input>`);
    const control = shadow(input, "input") as HTMLInputElement;
    expect(shadow(input, "label").textContent).toBe("Name");
    expect(shadow(input, "hint").hidden).toBe(false);
    expect(control.getAttribute("aria-describedby")).toBe("hint");
    expect(control.placeholder).toBe("Zombie farm");
    input.setAttribute("error", "Too long.");
    expect(shadow(input, "hint").hidden).toBe(true);
    expect(shadow(input, "error").textContent).toBe("Too long.");
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(control.getAttribute("aria-describedby")).toBe("error");
    input.removeAttribute("error");
    expect(control.hasAttribute("aria-invalid")).toBe(false);
    input.setAttribute("disabled", "");
    expect(control.disabled).toBe(true);
    input.removeAttribute("disabled");
    input.removeAttribute("hint");
    expect(control.hasAttribute("aria-describedby")).toBe(false);
    input.removeAttribute("label");
    input.setAttribute("aria-label", "Name");
    expect(shadow(input, "label").hidden).toBe(true);
    expect(control.getAttribute("aria-label")).toBe("Name");
  });

  it("keeps what was typed until the page sets a value, and hears changes", () => {
    const input = html(`<omg-input value="first"></omg-input>`) as HTMLElement & { value: string };
    const control = shadow(input, "input") as HTMLInputElement;
    const heard = vi.fn();
    input.addEventListener("change", heard);
    expect(input.value).toBe("first");
    control.value = "typed";
    input.setAttribute("error", "Too long.");
    expect(input.value).toBe("typed");
    expect(input.getAttribute("value")).toBe("first");
    control.dispatchEvent(new Event("change", { bubbles: true }));
    expect(heard).toHaveBeenCalledOnce();
    input.setAttribute("value", "second");
    expect(input.value).toBe("second");
    input.value = "third";
    expect(control.value).toBe("third");

    const area = html(`<omg-textarea rows="5" value="Lines" readonly></omg-textarea>`) as HTMLElement & { value: string };
    const box = shadow(area, "textarea") as HTMLTextAreaElement;
    expect([Number(box.rows), box.readOnly, area.value]).toEqual([5, true, "Lines"]);
  });

  it("keeps a switch and a checkbox's state on the attribute", () => {
    for (const [tag, part] of [["omg-switch", "switch"], ["omg-checkbox", "checkbox"]] as const) {
      const toggle = html(`<${tag} label="Upload" checked></${tag}>`) as HTMLElement & { checked: boolean };
      const box = shadow(toggle, part) as HTMLInputElement;
      expect([box.checked, toggle.checked]).toEqual([true, true]);
      const heard: boolean[] = [];
      toggle.addEventListener("change", () => heard.push(toggle.hasAttribute("checked")));
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      expect(toggle.hasAttribute("checked")).toBe(false);
      expect(heard).toEqual([false]);
      toggle.checked = true;
      expect(box.checked).toBe(true);
      // A page clearing an error as it hears input keeps the box as the person left it.
      toggle.setAttribute("error", "Required");
      toggle.addEventListener("input", () => toggle.removeAttribute("error"), { once: true });
      box.checked = false;
      box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      expect([box.checked, toggle.hasAttribute("checked")]).toEqual([false, false]);
    }
    expect(shadow(html(`<omg-switch></omg-switch>`), "switch").getAttribute("role")).toBe("switch");
  });

  it.each([["omg-segmented", "segments"], ["omg-radio-group", "options"]])("draws %s from native options and retains selection and focus", async (tag, part) => {
    const segmented = html(`<${tag} label="Build for" value="b"><option value="a">A</option><option value="b">B</option><option value="c" disabled>C</option></${tag}>`) as HTMLElement & { value: string };
    await settle();
    const group = shadow(segmented, part!);
    const radios = () => [...group.querySelectorAll("input")];
    expect(group.getAttribute("aria-labelledby")).toBe("label");
    expect(radios().map((radio) => [radio.value, radio.checked, radio.disabled])).toEqual([["a", false, false], ["b", true, false], ["c", false, true]]);
    const heard: string[] = [];
    segmented.addEventListener("change", () => heard.push(segmented.value));
    radios()[0]!.checked = true;
    radios()[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(heard).toEqual(["a"]);
    expect(segmented.getAttribute("value")).toBe("a");
    segmented.value = "b";
    expect(radios()[1]!.checked).toBe(true);
    segmented.setAttribute("disabled", "");
    expect(radios().every((radio) => radio.disabled)).toBe(true);
    segmented.removeAttribute("disabled");
    expect(radios().map((radio) => radio.disabled)).toEqual([false, false, true]);
    segmented.insertAdjacentHTML("beforeend", `<option value="d">D</option>`);
    await settle();
    expect(radios().map((radio) => radio.value)).toEqual(["a", "b", "c", "d"]);
    expect(radios()[1]!.checked).toBe(true);
    // A choice made heard as input stays when the page changes the hint then.
    segmented.addEventListener("input", () => segmented.setAttribute("hint", "Saved"), { once: true });
    radios()[0]!.checked = true;
    radios()[0]!.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect([radios()[0]!.checked, segmented.getAttribute("value")]).toEqual([true, "a"]);
    // Options that change keep the keyboard where it was.
    radios()[0]!.focus();
    segmented.insertAdjacentHTML("beforeend", `<option value="e">E</option>`);
    await settle();
    expect((segmented.shadowRoot!.activeElement as HTMLInputElement | null)?.value).toBe("a");
  });

  it("checks native numeric constraints without rewriting edits", () => {
    const field = html(`<omg-input type="number" min="0" max="10" step="0.5" value="2"></omg-input>`) as HTMLElement & { value: string; checkValidity(): boolean };
    const input = shadow(field, "input") as HTMLInputElement;
    expect([input.min, input.max, input.step]).toEqual(["0", "10", "0.5"]);
    expect(field.checkValidity()).toBe(true);
    for (const value of ["-1", "11", "2.25"]) {
      field.value = value;
      expect(field.checkValidity(), value).toBe(false);
      field.setAttribute("hint", "Keep editing");
      expect(field.value).toBe(value);
    }
    field.setAttribute("step", "any");
    expect(field.checkValidity()).toBe(true);
    field.value = "11";
    field.removeAttribute("max");
    expect(input.hasAttribute("max")).toBe(false);
    expect(field.checkValidity()).toBe(true);
    field.value = "";
    expect(field.checkValidity(), "optional numeric fields may be empty").toBe(true);
  });

  it("keeps slider values and readout current before consumers handle input", () => {
    const slider = html(`<omg-slider label="Volume" min="0" max="1" step="0.1" value="0.4"></omg-slider>`) as HTMLElement & { value: number };
    const input = shadow(slider, "input") as HTMLInputElement;
    const values: number[] = [];
    const commits: number[] = [];
    slider.addEventListener("input", () => { values.push(slider.value); slider.setAttribute("hint", "Previewing"); });
    slider.addEventListener("change", () => commits.push(slider.value));
    expect(slider.value).toBe(0.4);
    expect(shadow(slider, "output").textContent).toBe("0.4");
    input.value = "0.7";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(values).toEqual([0.7]);
    expect(commits).toEqual([]);
    expect(slider.value).toBe(0.7);
    expect(shadow(slider, "output").textContent).toBe("0.7");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commits).toEqual([0.7]);
    slider.value = 0.2;
    expect(slider.value).toBe(0.2);
    expect(values).toEqual([0.7]);
    slider.setAttribute("disabled", "");
    expect(input.disabled).toBe(true);
    slider.setAttribute("error", "Unavailable");
    expect(input.getAttribute("aria-describedby")).toBe("error");
    expect(slider.value).toBe(0.2);
  });

  it("keeps radio groups independent and option descriptions as text", async () => {
    const wrapper = html(`<div><omg-radio-group label="Quality"><option value="fast" selected data-description="Fast preview">Draft</option><option value="full">Full</option></omg-radio-group><omg-radio-group aria-label="Other"><option value="fast" selected>Draft</option><option value="full">Full</option></omg-radio-group></div>`);
    await settle();
    const [first, second] = [...wrapper.querySelectorAll("omg-radio-group")] as (HTMLElement & { value: string })[];
    expect(first!.shadowRoot!.querySelector("small")!.textContent).toBe("Fast preview");
    (first!.shadowRoot!.querySelectorAll("input")[1] as HTMLInputElement).click();
    expect([first!.value, second!.value]).toEqual(["full", "fast"]);
    first!.querySelector("option")!.dataset.description = "<b>Literal</b>";
    await settle();
    expect(first!.shadowRoot!.querySelector("small")!.textContent).toBe("<b>Literal</b>");
    expect(first!.shadowRoot!.querySelector("b")).toBeNull();
    first!.replaceChildren();
    await settle();
    expect(first!.value).toBe("");
    expect(first!.shadowRoot!.querySelectorAll("input")).toHaveLength(0);
  });

  it("shows how far progress has got, or moves without a value", () => {
    const progress = html(`<omg-progress label="Uploading" value="30" max="60"></omg-progress>`);
    const track = shadow(progress, "track");
    expect(track.getAttribute("aria-label")).toBe("Uploading");
    expect(track.getAttribute("aria-valuenow")).toBe("30");
    expect(track.getAttribute("aria-valuemax")).toBe("60");
    expect(shadow(progress, "bar").style.width).toBe("50%");
    progress.setAttribute("value", "600");
    expect(shadow(progress, "bar").style.width).toBe("100%");
    progress.setAttribute("value", "30");
    progress.setAttribute("max", "Infinity");
    expect([track.getAttribute("aria-valuemax"), shadow(progress, "bar").style.width]).toEqual(["100", "30%"]);
    progress.removeAttribute("value");
    expect(track.hasAttribute("aria-valuenow")).toBe(false);
    expect(shadow(progress, "bar").classList.contains("moving")).toBe(true);
  });

  it("frames a picture, and says when it loaded or couldn't", () => {
    type Image = HTMLElement & { complete: boolean; naturalWidth: number };
    const image = html<Image>(`<omg-image src="a.png" alt="A slime" ratio="16 / 9" fit="cover"></omg-image>`);
    const picture = () => shadow(image, "image") as HTMLImageElement;
    const frame = shadow(image, "frame");
    expect([picture().getAttribute("src"), picture().alt, frame.style.aspectRatio]).toEqual(["a.png", "A slime", "16 / 9"]);
    expect([image.complete, frame.classList.contains("loaded")]).toEqual([false, false]);
    const events: string[] = [];
    image.addEventListener("load", () => events.push("load"));
    image.addEventListener("error", () => events.push("error"));
    const first = picture();
    first.dispatchEvent(new Event("load"));
    expect([events, image.complete, frame.classList.contains("loaded"), shadow(image, "broken").hidden]).toEqual([["load"], true, true, true]);
    // Drawing again for another attribute doesn't load it again.
    image.setAttribute("alt", "A green slime");
    expect([picture(), image.complete]).toEqual([first, true]);

    // A new address loads afresh, and a late report for the old one is ignored, even while the new one loads.
    image.setAttribute("src", "missing.png");
    expect([image.complete, image.naturalWidth, picture() === first, picture().alt]).toEqual([false, 0, false, "A green slime"]);
    first.dispatchEvent(new Event("load"));
    expect([events, image.complete]).toEqual([["load"], false]);
    picture().dispatchEvent(new Event("error"));
    expect([events, image.complete, shadow(image, "broken").hidden]).toEqual([["load", "error"], true, false]);
    picture().dispatchEvent(new Event("load"));
    expect(events).toEqual(["load", "error"]);
    // Setting the same address again tries it again.
    const failed = picture();
    image.setAttribute("src", "missing.png");
    expect([picture() === failed, picture().getAttribute("src"), image.complete, shadow(image, "broken").hidden]).toEqual([false, "missing.png", false, true]);
    picture().dispatchEvent(new Event("load"));
    expect(events).toEqual(["load", "error", "load"]);

    // Out of the page, a new address still makes the old picture's late report not count.
    const loading = picture();
    image.remove();
    image.setAttribute("src", "b.png");
    loading.dispatchEvent(new Event("load"));
    expect([image.complete, events.length]).toEqual([false, 3]);
    document.body.append(image);

    // A shape it can't use leaves the picture at its own.
    for (const ratio of ["0", "-1/2", "wide", "4/0"]) {
      image.setAttribute("ratio", ratio);
      expect(frame.style.aspectRatio, ratio).toBe("");
    }
    image.setAttribute("ratio", "1.5");
    expect(frame.style.aspectRatio).toBe("1.5 / 1");
    image.removeAttribute("src");
    expect([picture().hasAttribute("src"), shadow(image, "broken").hidden, image.complete]).toEqual([false, true, false]);
  });

  it("shows a project file, and lets go of its address once drawn", async () => {
    let made = 0;
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++made}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const refused = new Set(["secret/none.png"]);
    answer = (id, method, params) =>
      method === "files.read" && refused.has(String(params?.path))
        ? app.postMessage({ id, error: "This plugin can't read the project's files" })
        : app.postMessage({ id, result: method === "files.read" ? new NodeBlob(["png"]) : { ok: true } });
    try {
      type Image = HTMLElement & { complete: boolean };
      const image = html<Image>(`<omg-image file="art/hero.png" src="fallback.png" alt="Hero"></omg-image>`);
      const picture = () => shadow(image, "image") as HTMLImageElement;
      const events: string[] = [];
      image.addEventListener("load", () => events.push("load"));
      image.addEventListener("error", () => events.push("error"));
      await settle();
      expect(calls).toEqual([{ method: "files.read", params: { path: "art/hero.png" } }]);
      expect([picture().getAttribute("src"), image.complete]).toEqual(["blob:test-1", false]);
      picture().dispatchEvent(new Event("load"));
      expect([events, image.complete, revoke.mock.calls]).toEqual([["load"], true, [["blob:test-1"]]]);

      // Set again, it reads the file again.
      image.setAttribute("file", "art/hero.png");
      await settle();
      expect(calls.map((call) => call.params?.path)).toEqual(["art/hero.png", "art/hero.png"]);
      expect(picture().getAttribute("src")).toBe(`blob:test-${made}`);
      // Replaced at once, the first is never read; replaced while reading, its address goes unused.
      image.setAttribute("file", "art/first.png");
      image.setAttribute("file", "art/other.png");
      await settle();
      expect(calls.map((call) => call.params?.path)).toEqual(["art/hero.png", "art/hero.png", "art/other.png"]);
      image.setAttribute("file", "art/slow.png");
      await Promise.resolve();
      await Promise.resolve();
      image.setAttribute("file", "art/other.png");
      await settle();
      expect(calls.at(-2)?.params?.path).toBe("art/slow.png");
      expect(picture().getAttribute("src")).toBe(`blob:test-${made}`);
      expect(revoke.mock.calls).toContainEqual([`blob:test-${made - 1}`]);

      // A read the app refuses is a picture that couldn't load.
      image.setAttribute("file", "secret/none.png");
      await settle();
      expect([events, image.complete, shadow(image, "broken").hidden]).toEqual([["load", "error"], true, false]);
      // While there's a file, src isn't the picture, so setting it reads nothing; without a file, it is.
      const reads = calls.length;
      image.setAttribute("src", "fallback.png");
      await settle();
      expect(calls.length).toBe(reads);
      image.removeAttribute("file");
      expect(picture().getAttribute("src")).toBe("fallback.png");

      // Taken out of the page while the file is read, or before it's drawn, it lets go of the address and loads again if it comes back.
      calls.length = 0;
      revoke.mockClear();
      const removed = html<Image>(`<omg-image file="art/hero.png"></omg-image>`);
      await Promise.resolve();
      await Promise.resolve();
      removed.remove();
      await settle();
      expect(calls.length).toBe(1);
      expect(revoke.mock.calls).toEqual([[`blob:test-${made}`]]);
      expect([shadow(removed, "image").hasAttribute("src"), removed.complete]).toEqual([false, false]);
      document.body.append(removed);
      await settle();
      expect(calls.length).toBe(2);
      expect(shadow(removed, "image").getAttribute("src")).toBe(`blob:test-${made}`);
      removed.remove();
      expect(revoke.mock.calls.at(-1)).toEqual([`blob:test-${made}`]);

      // Once drawn, it stays drawn: there's no address left to let go of, and nothing to read.
      document.body.append(removed);
      await settle();
      shadow(removed, "image").dispatchEvent(new Event("load"));
      const drawn = calls.length;
      removed.remove();
      document.body.append(removed);
      await settle();
      expect([calls.length, removed.complete]).toEqual([drawn, true]);

      // Upgraded in a page, each attribute is reported first, already connected: drawing waits, so the file is read once.
      for (const markup of [["omg-image", { src: "fallback.png", file: "art/hero.png" }], ["omg-tile", { heading: "Hero", file: "art/hero.png" }]] as const) {
        document.body.replaceChildren();
        calls.length = 0;
        const element = document.createElement(markup[0]);
        Object.defineProperty(element, "isConnected", { configurable: true, value: true });
        for (const [name, value] of Object.entries(markup[1])) element.setAttribute(name, value);
        await settle();
        expect(calls.length, markup[0]).toBe(0);
        delete (element as unknown as { isConnected?: boolean }).isConnected;
        document.body.append(element);
        await settle();
        expect(calls.length, markup[0]).toBe(1);
      }

      // A tile removed while loading and given another file reads only that one when it comes back.
      calls.length = 0;
      const moved = html(`<omg-tile heading="hero.png" file="art/hero.png"></omg-tile>`);
      moved.remove();
      moved.setAttribute("file", "art/next.png");
      await settle();
      calls.length = 0;
      document.body.append(moved);
      await settle();
      expect(calls.map((call) => call.params?.path)).toEqual(["art/next.png"]);

      // A tile with both sources reads its file once, and uses src once the file goes.
      calls.length = 0;
      const tile = html(`<omg-tile heading="hero.png" file="art/hero.png" src="fallback.png"></omg-tile>`);
      const inner = shadow(tile, "image");
      await settle();
      expect(calls.length).toBe(1);
      expect([inner.getAttribute("file"), inner.hasAttribute("src")]).toEqual(["art/hero.png", false]);
      tile.setAttribute("description", "PNG");
      tile.setAttribute("src", "other.png");
      await settle();
      expect(calls.length).toBe(1);
      tile.setAttribute("file", "art/hero.png");
      await settle();
      expect(calls.length).toBe(2);
      tile.removeAttribute("file");
      await settle();
      expect([calls.length, inner.hasAttribute("file"), inner.getAttribute("src")]).toEqual([2, false, "other.png"]);
      expect(create).toHaveBeenCalled();
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it("draws a tile as a button with its picture and name", () => {
    type Tile = HTMLElement & { selected: boolean; disabled: boolean };
    const tile = html<Tile>(`<omg-tile heading="slime.png" description="PNG" badge="4 frames" src="slime.png" pixelated selected></omg-tile>`);
    const button = shadow(tile, "tile") as HTMLButtonElement;
    const image = shadow(tile, "image");
    expect([shadow(tile, "heading").textContent, shadow(tile, "heading").title, shadow(tile, "description").textContent, shadow(tile, "badge").textContent]).toEqual(["slime.png", "slime.png", "PNG", "4 frames"]);
    expect([image.getAttribute("src"), image.hasAttribute("pixelated"), image.getAttribute("fit")]).toEqual(["slime.png", true, "cover"]);
    expect(shadow(tile, "preview").style.aspectRatio).toBe("4 / 3");
    expect(button.getAttribute("aria-current")).toBe("true");
    // Its picture loads once, not again each time the tile draws; setting the same address tries it again.
    const picture = shadow(image, "image");
    tile.setAttribute("description", "PNG, 16 × 16");
    expect(shadow(image, "image")).toBe(picture);
    tile.setAttribute("src", "slime.png");
    expect(shadow(image, "image")).not.toBe(picture);
    tile.selected = false;
    tile.disabled = true;
    tile.setAttribute("fit", "contain");
    tile.setAttribute("ratio", "1");
    tile.removeAttribute("badge");
    tile.removeAttribute("pixelated");
    const picked = vi.fn();
    tile.addEventListener("click", picked);
    tile.click();
    expect(picked).not.toHaveBeenCalled();
    tile.disabled = false;
    tile.click();
    expect(picked).toHaveBeenCalledTimes(1);
    tile.disabled = true;
    expect([button.hasAttribute("aria-current"), button.disabled, image.getAttribute("fit"), image.hasAttribute("pixelated"), shadow(tile, "badge").hidden]).toEqual([false, true, "contain", false, true]);
    expect(shadow(tile, "preview").style.aspectRatio).toBe("1 / 1");
  });

  it("starts on the option marked selected when it has no value", async () => {
    const select = html<HTMLElement & { value: string }>(`<omg-select aria-label="Project"><option value="a">Alpha</option><option value="b" selected>Beta</option></omg-select>`);
    await settle();
    expect(select.value).toBe("b");
    expect(shadow(select, "select").getAttribute("aria-label")).toBe("Project");
  });

  it("runs a command with its input, busy and showing progress, and makes other command buttons wait", async () => {
    let finish!: () => void;
    answer = (id, method, params) => {
      if (params?.command !== "prepare") return app.postMessage({ id, result: null });
      app.postMessage({ event: "progress", command: "prepare", message: "Downloading…" });
      finish = () => app.postMessage({ id, result: { connection: "ready" } });
    };
    document.body.innerHTML = `<omg-command-button command="prepare" input='{"force":true}'>Prepare</omg-command-button><omg-command-button command="status">Check</omg-command-button>`;
    const [prepare, check] = document.querySelectorAll<HTMLElement>("omg-command-button");
    const results: unknown[] = [];
    prepare!.addEventListener("omg-command-result", (event) => results.push((event as CustomEvent).detail.result));
    shadow(prepare!, "button").click();
    await settle();
    expect(calls).toEqual([{ method: "command.run", params: { command: "prepare", input: { force: true } } }]);
    expect(prepare!.hasAttribute("busy")).toBe(true);
    expect(shadow(prepare!, "progress").textContent).toBe("Downloading…");
    expect((shadow(check!, "button") as HTMLButtonElement).disabled).toBe(true);
    // A busy button takes no second click.
    shadow(prepare!, "button").click();
    await settle();
    expect(calls).toHaveLength(1);
    finish();
    await settle();
    expect(results).toEqual([{ connection: "ready" }]);
    expect(prepare!.hasAttribute("busy")).toBe(false);
    expect(shadow(prepare!, "progress").hidden).toBe(true);
    expect((shadow(check!, "button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("starts one run however quickly it is clicked, and only from its button", async () => {
    let finish!: () => void;
    answer = (id) => {
      finish = () => app.postMessage({ id, result: null });
    };
    document.body.innerHTML = `<omg-command-button command="prepare">Prepare</omg-command-button><omg-command-button command="status">Check</omg-command-button>`;
    const [prepare, check] = document.querySelectorAll<HTMLElement>("omg-command-button");
    shadow(prepare!, "button").click();
    shadow(prepare!, "button").click();
    shadow(check!, "button").click();
    await settle();
    expect(calls).toEqual([{ method: "command.run", params: { command: "prepare" } }]);
    finish();
    await settle();
    // The failure text beside a button isn't the button.
    answer = (id) => app.postMessage({ id, error: "Failed" });
    shadow(prepare!, "button").click();
    await settle();
    calls = [];
    shadow(prepare!, "error").click();
    await settle();
    expect(calls).toEqual([]);
  });

  it("shows a command's failure unless the page handles it, and lets the page cancel a run", async () => {
    answer = (id) => app.postMessage({ id, error: "Python 3.8 or later is required" });
    const button = html(`<omg-command-button command="prepare">Prepare</omg-command-button>`);
    shadow(button, "button").click();
    await settle();
    expect(shadow(button, "error").textContent).toBe("Python 3.8 or later is required");
    expect(shadow(button, "error").getAttribute("role")).toBe("alert");
    // The failure is an attribute, so a page drawing the button again keeps it.
    expect(button.getAttribute("error")).toBe("Python 3.8 or later is required");
    const drawn = html(`<omg-command-button command="prepare" error="Still failing">Prepare</omg-command-button>`);
    expect(shadow(drawn, "error").textContent).toBe("Still failing");
    document.body.replaceChildren(button);

    button.addEventListener("omg-command-error", (event) => event.preventDefault());
    shadow(button, "button").click();
    await settle();
    expect(shadow(button, "error").hidden).toBe(true);
    expect(button.hasAttribute("error")).toBe(false);

    button.addEventListener("omg-command-start", (event) => event.preventDefault());
    calls = [];
    shadow(button, "button").click();
    await settle();
    expect(calls).toEqual([]);
  });

  it("reports a failure for the command that ran, even if the button's command changed", async () => {
    let fail!: () => void;
    answer = (id) => {
      fail = () => app.postMessage({ id, error: "Failed" });
    };
    const button = html(`<omg-command-button command="prepare">Prepare</omg-command-button>`);
    const errors: unknown[] = [];
    button.addEventListener("omg-command-error", (event) => errors.push((event as CustomEvent).detail));
    shadow(button, "button").click();
    await settle();
    button.removeAttribute("command");
    fail();
    await settle();
    expect(errors).toEqual([{ command: "prepare", error: "Failed" }]);
  });

  it("takes no clicks while disabled", async () => {
    const button = html(`<omg-command-button command="prepare" disabled>Prepare</omg-command-button>`);
    const clicks: Event[] = [];
    button.addEventListener("click", (event) => clicks.push(event));
    button.click();
    await settle();
    expect(clicks).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("keeps the gallery plugin valid and using only defined components", async () => {
    const manifest = JSON.parse(await readFile("packages/plugin-ui/gallery/.ohmygame-plugin/plugin.json", "utf8"));
    const checked = validatePluginManifest(manifest);
    expect(checked.ok ? [] : checked.issues).toEqual([]);
    // Version 1 is stable, so the gallery needs no opt-in.
    expect(manifest.ui.preview).toBeUndefined();
    const page = await readFile("packages/plugin-ui/gallery/panel/index.html", "utf8");
    const used = new Set([...page.matchAll(/<(omg-[a-z-]+)/g)].map(([, name]) => name!));
    expect([...used].filter((name) => !customElements.get(name))).toEqual([]);
    const docs = await readFile("docs/plugins.md", "utf8");
    expect([...used].filter((name) => !docs.includes(`\`${name}\``))).toEqual([]);
  });
});

describe("page components' contract", () => {
  it("is up to date with the components' doc comments", async () => {
    // A Windows checkout may have CRLF line endings.
    for (const { file, text } of await contractFiles()) expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n"), file).toBe(text);
  });

  it("lists what each component observes, its parts and slots, and its members", async () => {
    const manifest = await componentManifest("1");
    const docs = await readFile("docs/plugins.md", "utf8");
    expect(declarations(manifest).filter((item) => !docs.includes(`\`${item.tagName}\``)).map((item) => item.tagName)).toEqual([]);
    for (const item of declarations(manifest)) {
      const component = customElements.get(item.tagName) as (CustomElementConstructor & { observedAttributes?: string[] }) | undefined;
      expect(component, item.tagName).toBeDefined();
      const attributes = item.attributes.map((attribute) => attribute.name);
      expect((component!.observedAttributes ?? []).filter((name) => !attributes.includes(name)), item.tagName).toEqual([]);
      const element = document.createElement(item.tagName);
      const parts = new Set([...element.shadowRoot!.querySelectorAll("[part]")].flatMap((node) => node.getAttribute("part")!.split(/\s+/)));
      // These are drawn for each child, so they aren't in the template.
      if (item.tagName === "omg-tabs") parts.add("tab");
      if (item.tagName === "omg-segmented") parts.add("segment");
      if (item.tagName === "omg-radio-group") parts.add("option");
      expect([...parts].sort(), `${item.tagName} parts`).toEqual(item.cssParts.map((part) => part.name).sort());
      const slots = [...element.shadowRoot!.querySelectorAll("slot")].map((slot) => slot.getAttribute("name") ?? "");
      expect(slots.sort(), `${item.tagName} slots`).toEqual(item.slots.map((slot) => slot.name).sort());
      for (const member of item.members) expect(member.name in element, `${item.tagName}.${member.name}`).toBe(true);
    }
  });

  it("reads every form of tag", () => {
    const parsed = parseComment(
      [
        "`<omg-x>`: a thing.",
        "@attr {'a' | 'b  c'} mode - The mode,",
        "  over two lines.",
        '@prop {{ close: "}" }} value - A value.',
        "@readonly {number} size - How big it is.",
        "@method run",
        "@fires {{ id: string }} omg-x-done - Done.",
        "@fires change",
        "@slot - The content.",
        "@slot icon",
        "@part body - The body.",
        "@cssprop [--omg-x-height=calc(100vh - 20px)] - How tall.",
        "@cssprop --omg-accent",
        "@deprecated Use omg-y instead.",
      ]
        .map((line) => ` * ${line}`)
        .join("\r\n"),
      "OmgX",
      "OmgElement",
      "ui/1/x.js",
    );
    expect(parsed).toMatchObject({
      description: "`<omg-x>`: a thing.",
      deprecated: "Use omg-y instead.",
      attributes: [{ name: "mode", type: { text: "'a' | 'b  c'" }, description: "The mode, over two lines." }],
      members: [
        { kind: "field", name: "value", type: { text: '{ close: "}" }' } },
        { kind: "field", name: "size", type: { text: "number" }, readonly: true },
        { kind: "method", name: "run", return: { type: { text: "void" } } },
      ],
      events: [
        { name: "omg-x-done", type: { text: "CustomEvent<{ id: string }>" } },
        { name: "change", type: { text: "Event" } },
      ],
      slots: [{ name: "", description: "The content." }, { name: "icon" }],
      cssParts: [{ name: "body" }],
      cssProperties: [{ name: "--omg-x-height", default: "calc(100vh - 20px)", description: "How tall." }, { name: "--omg-accent" }],
    });
    expect(() => parseComment(" * @shout loud", "OmgX", "OmgElement", "ui/1/x.js")).toThrow("unknown tag @shout");
    expect(
      parseComment(" * @attr mode\n * @fires omg-x-done\n * @deprecated attr mode - Use kind.\n * @deprecated fires omg-x-done - Use change.", "OmgX", "OmgElement", "ui/1/x.js"),
    ).toMatchObject({ attributes: [{ name: "mode", deprecated: "Use kind." }], events: [{ name: "omg-x-done", deprecated: "Use change." }] });
    expect(parseComment(" * @deprecated", "OmgX", "OmgElement", "ui/1/x.js").deprecated).toBe("Deprecated.");
    const slot = parseComment(" * @slot - The content.\n * @deprecated slot - Use body.", "OmgX", "OmgElement", "ui/1/x.js");
    expect(slot).toMatchObject({ slots: [{ name: "", deprecated: "Use body." }] });
    expect(slot.deprecated).toBeUndefined();
    expect(() => parseComment(" * @deprecated attr mode - Use kind.", "OmgX", "OmgElement", "ui/1/x.js")).toThrow("names nothing");
  });

  it("warns once when a page uses what is deprecated, and says so wherever the contract does", async () => {
    for (const major of PLUGIN_UI_MAJORS)
      for (const item of declarations(await componentManifest(major))) {
        const type = customElements.get(item.tagName) as unknown as { deprecated?: string; deprecatedAttributes: Record<string, string>; observedAttributes?: string[] };
        expect(type.deprecated, item.tagName).toBe(item.deprecated);
        expect(Object.keys(type.deprecatedAttributes).filter((name) => !type.observedAttributes?.includes(name)), item.tagName).toEqual([]);
        expect(type.deprecatedAttributes, item.tagName).toEqual(
          Object.fromEntries(item.attributes.filter((attribute) => attribute.deprecated).map((attribute) => [attribute.name, attribute.deprecated])),
        );
      }
    const { OmgElement } = (await import(/* @vite-ignore */ path.join(served, "_ohmygame/ui/1/base.js"))) as { OmgElement: typeof HTMLElement };
    class Old extends OmgElement {
      static deprecated = "Use omg-new.";
      static deprecatedAttributes = { mode: "Use kind." };
    }
    customElements.define("omg-old-test", Old);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    html('<div><omg-old-test mode="a"></omg-old-test><omg-old-test mode="b"></omg-old-test><omg-old-test></omg-old-test></div>');
    await settle();
    // Set after it connected, as a script would, it warns too.
    class Late extends OmgElement {
      static observedAttributes = ["mode"];
      static deprecatedAttributes = { mode: "Use kind." };
    }
    customElements.define("omg-late-test", Late);
    html("<omg-late-test></omg-late-test>").setAttribute("mode", "a");
    await settle();
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[OhMyGame] <omg-old-test> is deprecated: Use omg-new.",
      "[OhMyGame] <omg-old-test>'s mode is deprecated: Use kind.",
      "[OhMyGame] <omg-late-test>'s mode is deprecated: Use kind.",
    ]);
    warn.mockRestore();
  });

  it("keeps a stable major served for its support window", () => {
    const today = "2027-06-01";
    const stable = { majors: ["1", "2"], preview: new Set<string>(), retiring: {} };
    const retiring = { ...stable, retiring: { 1: { since: "2026-01-01", until: "2027-07-01" } } };
    const check = (then: Parameters<typeof supportChanges>[0], majors: string[], dates: Parameters<typeof supportChanges>[1]["retiring"] = then.retiring) =>
      supportChanges(then, { majors, retiring: dates }, today, "dev");
    expect(check(stable, ["1", "2"])).toEqual({ breaking: [], notes: [] });

    // It can't just go, or go before the date it had.
    expect(check(stable, ["2"]).breaking).toEqual(["Components 1 were stable at dev and are no longer served."]);
    expect(check(retiring, ["2"]).breaking).toEqual(["Components 1 were stable at dev and must be served until 2027-07-01."]);
    expect(check({ ...retiring, retiring: { 1: { since: "2026-01-01", until: today } } }, ["2"]).breaking).toHaveLength(1);
    const past = { ...stable, retiring: { 1: { since: "2026-01-01", until: "2027-05-31" } } };
    expect(check(past, ["2"], {})).toEqual({ breaking: [], notes: ["Components 1: no longer served, after 2027-05-31"] });
    expect(check({ ...stable, preview: new Set(["1"]) }, ["2"])).toEqual({ breaking: [], notes: ["Components 1 (preview): no longer served"] });

    // Its date can't be moved closer, or be in the past when it's first set.
    expect(check(retiring, ["1", "2"], { 1: { since: "2025-01-01", until: "2026-01-01" } }).breaking).toEqual([expect.stringContaining("can't move closer")]);
    expect(check(retiring, ["1", "2"], { 1: { since: "2026-01-01", until: "2027-08-01" } }).breaking).toEqual([]);
    expect(check(stable, ["1", "2"], { 1: { since: "2025-01-01", until: "2026-01-01" } }).breaking).toEqual([expect.stringContaining("12 months from 2027-06-01")]);
    expect(check(stable, ["1", "2"], { 1: { since: today, until: "2028-06-01" } }).breaking).toEqual([]);
  });

  it("finds what would break a page", () => {
    const contract = (attributes: { name: string; type?: { text: string } }[], extra: Record<string, unknown> = {}): ComponentManifest => ({
      schemaVersion: "2.1.0",
      readme: "",
      modules: [
        {
          kind: "javascript-module",
          path: "ui/1/controls.js",
          declarations: [
            { kind: "class", name: "OmgButton", tagName: "omg-button", customElement: true, description: "", attributes, members: [], events: [], slots: [{ name: "" }], cssParts: [{ name: "button" }], cssProperties: [], ...extra },
          ],
          exports: [],
        },
      ],
    });
    const before = contract([{ name: "variant", type: { text: '"primary" | "ghost"' } }, { name: "busy", type: { text: "boolean" } }]);
    expect(contractChanges(before, before)).toEqual({ breaking: [], added: [] });
    expect(contractChanges(before, contract([{ name: "variant", type: { text: '"primary" | "ghost"' }, deprecated: "Use kind." } as never, ...before.modules[0]!.declarations[0]!.attributes.slice(1)], { cssParts: before.modules[0]!.declarations[0]!.cssParts }))).toEqual({
      breaking: [],
      added: ["<omg-button> attribute variant is deprecated: Use kind."],
    });
    expect(contractChanges(before, contract([{ name: "variant", type: { text: '"primary" | "ghost" | "danger"' } }, { name: "busy", type: { text: "boolean" } }, { name: "size" }]))).toEqual({
      breaking: [],
      added: ['<omg-button> attribute variant takes "danger"', "<omg-button> attribute size"],
    });
    expect(contractChanges(before, contract([{ name: "variant", type: { text: '"primary"' } }], { cssParts: [] })).breaking).toEqual([
      '<omg-button> attribute variant changed from "primary" | "ghost" to "primary"',
      "<omg-button> attribute busy was removed",
      "<omg-button> part button was removed",
    ]);
    expect(contractChanges(before, { ...before, modules: [] }).breaking).toEqual(["<omg-button> was removed"]);
    // Its types are named after the class.
    expect(contractChanges(before, contract(before.modules[0]!.declarations[0]!.attributes, { name: "OmgAction" })).breaking).toEqual([
      "<omg-button>'s class OmgButton, which names its types, became OmgAction",
    ]);
    const run = (kind: "field" | "method") => contract([], { members: [{ kind, name: "run", ...(kind === "method" ? { return: { type: { text: "void" } } } : { type: { text: "void" } }) }] });
    expect(contractChanges(run("method"), run("field")).breaking).toEqual(["<omg-button> member run became a property"]);
    const size = (readonly: boolean) => contract([], { members: [{ kind: "field", name: "size", type: { text: "number" }, ...(readonly ? { readonly } : {}) }] });
    expect(contractChanges(size(false), size(true))).toEqual({ breaking: ["<omg-button> member size became read-only"], added: [] });
    expect(contractChanges(size(true), size(false))).toEqual({ breaking: [], added: ["<omg-button> member size can be set"] });
    expect(contractChanges(contract([{ name: "mode", type: { text: "'a'" } }]), contract([{ name: "mode", type: { text: '"a" | "b"' } }])).added).toEqual([
      '<omg-button> attribute mode takes "b"',
    ]);
  });

  it("declares types for members a base class gives and events components share", () => {
    const event = { name: "omg-done", type: { text: "CustomEvent<{ id: string }>" } };
    const component = (name: string, tagName: string, extra: Record<string, unknown>) => ({
      kind: "class" as const, name, tagName, customElement: true as const, description: "", attributes: [], members: [], events: [], slots: [], cssParts: [], cssProperties: [], ...extra,
    });
    const types = componentTypes({
      schemaVersion: "2.1.0",
      readme: "",
      modules: [
        {
          kind: "javascript-module",
          path: "ui/1/x.js",
          declarations: [
            // Its base class isn't a component, so its interface declares what that base gives.
            component("OmgA", "omg-a", { superclass: { name: "Shared", module: "ui/1/x.js" }, members: [{ kind: "field", name: "shared", type: { text: "string" }, inheritedFrom: { name: "Shared", module: "ui/1/x.js" } }], events: [event] }),
            component("OmgB", "omg-b", { superclass: { name: "OmgA", module: "ui/1/x.js" }, members: [{ kind: "field", name: "shared", type: { text: "string" }, inheritedFrom: { name: "Shared", module: "ui/1/x.js" } }], events: [event] }),
          ],
          exports: [],
        },
      ],
    });
    expect(types).toContain("export interface OmgAElement extends HTMLElement {\n  shared: string;\n}");
    expect(types).toContain("export interface OmgBElement extends OmgAElement {}");
    expect(types.match(/"omg-done":/g)).toHaveLength(1);

    const shared = { kind: "field" as const, name: "shared", type: { text: "string" } };
    const go = { name: "omg-go", type: { text: "CustomEvent<string>" } };
    const deprecation = componentTypes({
      schemaVersion: "2.1.0",
      readme: "",
      modules: [
        {
          kind: "javascript-module",
          path: "ui/1/x.js",
          declarations: [
            component("OmgA", "omg-a", { members: [shared], events: [{ ...go, deprecated: "Use omg-run." }, { name: "omg-old", type: go.type, deprecated: "Use omg-new." }] }),
            // Only this one deprecates what it inherits, so its interface says so.
            component("OmgB", "omg-b", { superclass: { name: "OmgA", module: "ui/1/x.js" }, members: [{ ...shared, deprecated: "Use other." }], events: [go] }),
          ],
          exports: [],
        },
      ],
    });
    expect(deprecation).toMatch(/interface OmgBElement extends OmgAElement \{\n[^}]*@deprecated Use other\.[^}]*shared: string;/);
    // Another component still fires omg-go as it was, while nothing else fires omg-old.
    expect(deprecation).not.toContain("Use omg-run.");
    expect(deprecation).toContain("@deprecated Use omg-new.");
  });
});

describe("regression check", () => {
  const run = (issues: string[], picture = "a", scenario?: string) => ({ plugin: "acme/panel", panel: "main", ...(scenario ? { scenario } : {}), appearance: "dark", issues, picture });

  it("fails on anything wrong when there is nothing to compare with", () => {
    expect(compareRuns(undefined, [run([]), run(["console: boom"])])).toEqual({ failures: ["acme/panel main (dark): console: boom"], changed: [] });
  });

  it("fails only on what is newly wrong, and lists what looks different without failing", () => {
    expect(compareRuns([run(["console: old"])], [run(["console: old"])])).toEqual({ failures: [], changed: [] });
    expect(compareRuns([run(["console: old"])], [run(["console: old", "<omg-x> never registered"], "b")])).toEqual({
      failures: ["acme/panel main (dark): <omg-x> never registered"],
      changed: ["acme/panel main (dark)"],
    });
    // A page needn't connect, but one that did and stopped has broken.
    expect(compareRuns(undefined, [{ ...run([]), connected: false }]).failures).toEqual([]);
    expect(compareRuns([{ ...run([]), connected: false }], [{ ...run([]), connected: false }]).failures).toEqual([]);
    expect(compareRuns([{ ...run([]), connected: true }], [{ ...run([]), connected: false }]).failures).toEqual(["acme/panel main (dark): the page no longer connects to the app"]);
    // Each scenario is its own view.
    expect(compareRuns([run([], "a"), run([], "b", "connected")], [run([], "a"), run(["console: boom"], "b", "connected")]).failures).toEqual(["acme/panel main connected (dark): console: boom"]);
  });
});

describe("plugin check", () => {
  async function plugin(files: Record<string, string>, ui: object = { major: 1 }, extra: object = {}): Promise<string> {
    const root = path.join(served, `check-${Math.random().toString(36).slice(2)}`);
    const manifest = { id: "acme/panel", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Panel", description: "A panel", icon: "./icon.svg", ui, contributes: { panels: [{ id: "main", title: "Main", area: "center", entry: "./panel/index.html" }] }, ...extra };
    await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), JSON.stringify(manifest));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@acme/panel", version: "1.0.0" }));
    await mkdir(path.join(root, "panel"));
    await writeFile(path.join(root, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>');
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, "panel", file), text);
    return root;
  }
  const load = '<script type="module" src="/_ohmygame/ui/1/index.js"></script>';
  const messages = async (root: string, level: "error" | "warning") =>
    (await checkPlugin(root)).filter((finding) => finding.level === level).map((finding) => finding.message);

  it("checks the npm name and version the package will be added by", async () => {
    const root = await plugin({ "index.html": load });
    const named = async (pkg: object) => {
      await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
      return messages(root, "error");
    };
    expect(await named({ name: "@acme/ohmygame-plugin-panel", version: "1.0.0" })).toEqual([]);
    expect(await named({ name: "panel", version: "1.0.0" })).toEqual(["The package's name must be scoped by the plugin's publisher: @acme/panel"]);
    expect(await named({ name: "@other/panel", version: "1.0.0" })).toEqual([expect.stringContaining("can only hold the plugin other/panel")]);
    expect(await named({ name: "@acme/panel", version: "1.0.1" })).toEqual(["The package's version 1.0.1 isn't the plugin's 1.0.0"]);
    // One that isn't published is only added from GitHub or a folder.
    expect(await named({ name: "panel", private: true })).toEqual([]);
    await rm(path.join(root, "package.json"));
    expect(await messages(root, "warning")).toContainEqual(expect.stringContaining("There is no package.json"));
  });

  it("warns about fields this app would leave out, and checks screenshots are in the package and small", async () => {
    const root = await plugin({ "index.html": load }, { major: 1 }, {
      categories: ["art", "hologram"], homepage: "https://example.com",
      screenshots: [{ path: "./shots/one.png" }, { path: "./shots/big.png" }, { path: "./shots/gone.png" }],
    });
    await mkdir(path.join(root, "shots"));
    await writeFile(path.join(root, "shots", "one.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(path.join(root, "shots", "big.png"), Buffer.alloc(1024 * 1024 + 1));
    expect(await messages(root, "warning")).toEqual([
      "/categories/1 \"hologram\" isn't known to this version of OhMyGame, so it's ignored",
      "/homepage isn't known to this version of OhMyGame, so it's ignored",
    ]);
    expect(await messages(root, "warning")).not.toContainEqual(expect.stringContaining("no icon"));
    // One without an icon is shown by its first letter, which the author should know.
    // (One with panels needs it for their tabs, so that's an error.)
    expect(await messages(await plugin({}, { major: 1 }, { icon: undefined, ui: undefined, contributes: {} }), "warning"))
      .toContainEqual(expect.stringContaining("There is no icon"));
    expect(await messages(root, "error")).toEqual([
      "/screenshots/1/path ./shots/big.png is larger than 1 MB",
      "/screenshots/2/path ./shots/gone.png is not in the package",
    ]);
  });

  it("checks only what npm would publish from a folder", async () => {
    const root = await plugin({ "index.html": load });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@acme/panel", version: "1.0.0", files: [".ohmygame-plugin", "icon.svg", "panel"] }));
    await mkdir(path.join(root, "drafts"));
    await writeFile(path.join(root, "drafts", "old.html"), "<omg-nope></omg-nope>");
    await writeFile(path.join(root, "panel", "notes.html.orig"), "<omg-nope></omg-nope>");
    expect((await checkFolder(root)).filter((finding) => finding.level === "error")).toEqual([]);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@acme/panel", version: "1.0.0", files: [".ohmygame-plugin", "panel"] }));
    expect((await checkFolder(root)).map((finding) => finding.message)).toEqual([expect.stringMatching(/^\/icon \.\/icon\.svg is not in the package, as npm leaves it out/)]);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@acme/panel", version: "1.0.0", files: ["panel"] }));
    expect((await checkFolder(root)).map((finding) => finding.message)).toEqual([expect.stringContaining("plugin.json is missing or not JSON, as npm leaves it out")]);
  });

  it("finds nothing wrong in the plugins the app ships or shows", async () => {
    for (const folder of [".runtime/preinstalled-plugin-sources/taptap-maker", "packages/plugin-ui/gallery"]) expect(await messages(folder, "error"), folder).toEqual([]);
  });

  it("fails on what can't work", async () => {
    const page = await plugin({ "index.html": `${load}<script>alert(1)</script><script src="https://cdn.example.com/x.js"></script><omg-nope></omg-nope>` });
    expect(await messages(page, "error")).toEqual([
      expect.stringContaining("no inline scripts"),
      expect.stringContaining("no remote scripts"),
      "There is no component <omg-nope>",
    ]);
    expect(await messages(await plugin({ "index.html": "<omg-button></omg-button>" }), "error")).toEqual([expect.stringContaining("no script loads")]);
    expect(await messages(await plugin({ "index.html": '<script type="module" src="/_ohmygame/ui/999/index.js"></script>' }), "error")).toEqual([expect.stringContaining("aren't served")]);
    expect(await messages(await plugin({ "index.html": '<script src="/_ohmygame/ui/1/index.js"></script>' }), "error")).toEqual([expect.stringContaining('type="module"')]);
    expect(await messages(await plugin({ "index.html": `${load}<omg-button onclick="save()" data-on="x"></omg-button>` }), "error")).toEqual([expect.stringContaining("inline event handlers: onclick")]);
    expect(await messages(await plugin({ "index.html": `${load}<script type="module" src="./main.js"></script>`, "main.js": 'import { html } from "https://esm.sh/lit";\nconst shown = "from https://example.com";' }), "error")).toEqual([expect.stringContaining("no remote scripts: https://esm.sh/lit")]);
    // Nor does a page beside it, in the same folder.
    const beside = await plugin({ "main.html": load, "settings.html": "<omg-button></omg-button>" }, { major: 1 }, { contributes: { panels: [{ id: "main", title: "Main", area: "center", entry: "./panel/main.html" }, { id: "settings", title: "Settings", area: "center", entry: "./panel/settings.html" }] } });
    expect(await checkPlugin(beside)).toContainEqual({ level: "error", file: path.join("panel", "settings.html"), message: expect.stringContaining("no script loads") });
    // Another panel loading them doesn't help: it's another page.
    const two = await plugin({ "index.html": load }, { major: 1 }, { contributes: { panels: [{ id: "one", title: "One", area: "center", entry: "./panel/index.html" }, { id: "two", title: "Two", area: "center", entry: "./two/index.html" }] } });
    await mkdir(path.join(two, "two"));
    await writeFile(path.join(two, "two/index.html"), "<omg-button></omg-button>");
    expect(await checkPlugin(two)).toContainEqual({ level: "error", file: path.join("two", "index.html"), message: expect.stringContaining("no script loads") });
    // Version 1 is stable: a plugin needn't opt in to it.
    expect(await messages(await plugin({ "index.html": load }, {}), "error")).toEqual([]);
    expect(await messages(await plugin({ "index.html": `${load}<script TYPE="MODULE">go()</script>` }), "error")).toEqual([expect.stringContaining("no inline scripts")]);
    // The install's own checks come first.
    expect(await messages(await plugin({ "index.html": load }, { major: 999 }), "error")).toEqual([expect.stringContaining("Update OhMyGame")]);
  });

  it("doesn't fail a page for what works", async () => {
    const page = await plugin({
      "index.html": `<script SRC="./main.js" type="module"></script>${load}<script type="application/json">{}</script><script type="text/plain"><omg-note></omg-note></script><textarea><omg-example><script>startGame()</script></textarea><title><omg-title></title><omg-button></omg-button>`,
      "main.js": 'document.body.textContent = "<omg-example>";',
    });
    expect(await messages(page, "error")).toEqual([]);
    expect(await messages(await plugin({ "index.html": `<script data-src="https://example.com/x.js" src="./main.js"></script>${load}<p>Moving on: /_ohmygame/ui/999/index.js</p>` }), "error")).toEqual([]);
    expect(await messages(await plugin({ "index.html": '<script type="module" src="./main.js"></script><omg-button></omg-button>', "main.js": 'import(`/_ohmygame/ui/${major}/index.js`);' }), "error")).toEqual([]);
    // At the package's root, only the page itself is served.
    const rootPage = await plugin({}, { major: 1 }, { contributes: { panels: [{ id: "main", title: "Main", area: "center", entry: "./index.html" }] } });
    await writeFile(path.join(rootPage, "index.html"), load);
    await mkdir(path.join(rootPage, "templates"));
    await writeFile(path.join(rootPage, "templates/game.html"), "<script>game()</script>");
    expect(await messages(rootPage, "error")).toEqual([]);
    // Panels may share a script that loads them.
    const shared = await plugin({ "index.html": '<script type="module" src="./main.js"></script><omg-button></omg-button>', "main.js": 'import "/_ohmygame/ui/1/index.js";' }, { major: 1 }, { contributes: { panels: [{ id: "main", title: "Main", area: "center", entry: "./panel/index.html" }, { id: "settings", title: "Settings", area: "center", entry: "./settings/index.html" }] } });
    await mkdir(path.join(shared, "settings"));
    await writeFile(path.join(shared, "settings/index.html"), '<script type="module" src="../panel/main.js"></script><omg-button></omg-button>');
    expect(await messages(shared, "error")).toEqual([]);
    // Nor does it have to load them from its own folder.
    const fromAssets = await plugin({}, { major: 1 }, { contributes: { panels: [{ id: "main", title: "Main", area: "center", entry: "./index.html" }] } });
    await writeFile(path.join(fromAssets, "index.html"), '<script type="module" src="./assets/main.js"></script><omg-button></omg-button>');
    await mkdir(path.join(fromAssets, "assets"));
    await writeFile(path.join(fromAssets, "assets/main.js"), 'import "/_ohmygame/ui/1/index.js";');
    expect(await messages(fromAssets, "error")).toEqual([]);
    // A page's major isn't known here, so what it uses can't be judged, beyond saying so.
    expect(await messages(await plugin({ "index.html": '<script type="module" src="/_ohmygame/ui/999/index.js"></script><omg-future></omg-future>' }), "error")).toEqual([expect.stringContaining("aren't served")]);
  });

  it("warns about what won't match the app or won't last", async () => {
    const warnings = await messages(
      await plugin({
        "index.html": `${load}<link rel="stylesheet" href="./page.css"><!-- <omg-comment> --><omg-button variant="primary" data-x="1" aria-label="Go" wobble></omg-button>`,
        "page.css": "/* color: #123456 */ :root { --own: #fff; } a:not(#top) { color: var(--own); background: url(#fade); } b { color: #abcdef; border: 1px solid var(--color-border); fill: var(--mystery); } omg-button::part(nope) { color: inherit; }",
        "page.js": 'document.createElement("omg-maybe"); addEventListener("omg-command-result", () => {});\n// "omg-comment"\n',
      }),
      "warning",
    );
    expect(warnings).toEqual([
      "<omg-button> has no attribute wobble",
      "There is no component <omg-maybe>",
      expect.stringContaining("color: #abcdef"),
      "--mystery isn't one of the app's tokens",
      "No component has a part named nope",
    ]);
    expect(await messages(await plugin({ "index.html": load }, {}), "warning")).toContainEqual(expect.stringContaining('"major": 1'));
  });
});
