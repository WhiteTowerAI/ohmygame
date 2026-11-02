// @vitest-environment happy-dom
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ComponentManifest, componentManifest, componentTypes, contractChanges, contractFiles, declarations, parseComment } from "../scripts/plugin-ui-contract.js";
import { validatePluginManifest } from "../src/shared/plugin-manifest.js";

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
    // `input` already crosses the shadow boundary; it arrives once.
    const inputs: Event[] = [];
    select.addEventListener("input", (event) => inputs.push(event));
    native.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(inputs).toHaveLength(1);
    // As a native select, a value no option has leaves nothing chosen.
    select.value = "missing";
    expect(select.value).toBe("");
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
    expect(manifest.ui.preview).toBe(true);
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
  });
});
