// @vitest-environment happy-dom
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The components load as the app serves them, next to the bridge at
// /_ohmygame/plugin-ui.js, so they are copied into that layout first, in the
// project's ignored .runtime folder, where the test's module loader reaches.
let served: string;
let calls: { method: string; params?: Record<string, unknown> }[];
let answer: (id: number, method: string, params?: Record<string, unknown>) => void;
let app: MessagePort;

beforeAll(async () => {
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
    prepare!.click();
    await settle();
    expect(calls).toHaveLength(1);
    finish();
    await settle();
    expect(results).toEqual([{ connection: "ready" }]);
    expect(prepare!.hasAttribute("busy")).toBe(false);
    expect(shadow(prepare!, "progress").hidden).toBe(true);
    expect((shadow(check!, "button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a command's failure unless the page handles it, and lets the page cancel a run", async () => {
    answer = (id) => app.postMessage({ id, error: "Python 3.8 or later is required" });
    const button = html(`<omg-command-button command="prepare">Prepare</omg-command-button>`);
    shadow(button, "button").click();
    await settle();
    expect(shadow(button, "error").textContent).toBe("Python 3.8 or later is required");
    expect(shadow(button, "error").getAttribute("role")).toBe("alert");

    button.addEventListener("omg-command-error", (event) => event.preventDefault());
    shadow(button, "button").click();
    await settle();
    expect(shadow(button, "error").hidden).toBe(true);

    button.addEventListener("omg-command-start", (event) => event.preventDefault());
    calls = [];
    shadow(button, "button").click();
    await settle();
    expect(calls).toEqual([]);
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
});
