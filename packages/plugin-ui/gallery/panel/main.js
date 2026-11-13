// The gallery's own behaviour: moving the steps, showing command results,
// the chosen option, log lines and the picked tile. The components connect themselves.
import { connect } from "/_ohmygame/plugin-ui.js";

const steps = [...document.querySelectorAll("#steps > omg-step")];
const initial = steps.map((step) => step.getAttribute("state"));
let current = 1;

function showStep(index, failed = false) {
  current = Math.max(0, Math.min(index, steps.length));
  steps.forEach((step, at) =>
    step.setAttribute("state", at < current ? "done" : at === current ? (failed ? "error" : "current") : "pending"),
  );
}

const log = document.getElementById("log");
const actions = {
  next: () => showStep(current + 1),
  fail: () => showStep(current, true),
  reset: () => {
    current = 1;
    steps.forEach((step, at) => step.setAttribute("state", initial[at]));
  },
  add: () => {
    const lines = log.text ? log.text.split("\n") : [];
    log.text = [...lines, `Line ${lines.length + 1}`].join("\n");
  },
  clear: () => (log.text = ""),
};
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-step], [data-log]") : null;
  actions[target?.getAttribute("data-step") ?? target?.getAttribute("data-log")]?.();
});

const commandResult = document.getElementById("result");
document.addEventListener("omg-command-result", (event) => {
  show(commandResult, "good", `“${event.detail.command}” finished: ${JSON.stringify(event.detail.result)}`);
});
document.addEventListener("omg-command-error", (event) => {
  show(commandResult, "bad", `“${event.detail.command}” failed.`);
});

// The app's own toasts and dialogs, and the command run from its toolbar.
const answer = document.getElementById("answer");
const show = (status, tone, value) => {
  if (tone) status.setAttribute("tone", tone);
  else status.removeAttribute("tone");
  status.textContent = value;
};
const asks = {
  toast: (host) => host.request("ui.toast", { message: "This toast comes from the gallery.", tone: "success" }),
  "toast-bad": (host) => host.request("ui.toast", { message: "This failure comes from the gallery.", tone: "danger" }),
  confirm: async (host) => {
    const yes = await host.request("ui.confirm", { title: "Reset the gallery?", message: "Nothing really happens; this only shows the app's dialog.", confirmLabel: "Reset" });
    show(answer, yes ? "good" : undefined, yes ? "You agreed." : "You said no.");
  },
};
document.addEventListener("click", (event) => {
  const name = event.target instanceof Element ? event.target.closest("[data-host]")?.getAttribute("data-host") : undefined;
  if (name) void connect().then(asks[name]).catch((error) => show(answer, "bad", error.message));
});
void connect().then((host) =>
  host.on("command", ({ command, result, error }) =>
    error ? show(commandResult, "bad", `“${command}” failed in the toolbar.`) : show(commandResult, "good", `“${command}” finished in the toolbar: ${JSON.stringify(result)}`),
  ),
);

const select = document.getElementById("select");
const chosen = document.getElementById("chosen");
const showChoice = () => (chosen.textContent = `Value: “${select.value}”`);
select.addEventListener("change", showChoice);
customElements.whenDefined("omg-select").then(showChoice);

const demoTabs = document.getElementById("demo-tabs");
const demoTab = document.getElementById("demo-tab");
demoTabs.addEventListener("omg-tab-change", (event) => (demoTab.textContent = `Open tab: “${event.detail.value}”`));

const typed = document.getElementById("typed");
document.getElementById("name").addEventListener("input", (event) => (typed.textContent = `Typed: “${event.target.value}”`));

const tiles = document.getElementById("tiles");
tiles.addEventListener("click", (event) => {
  const tile = event.target instanceof Element ? event.target.closest("omg-tile") : null;
  if (!tile || tile.disabled) return;
  for (const other of tiles.querySelectorAll("omg-tile")) other.selected = other === tile;
});

customElements.whenDefined("omg-menu").then(() => {
  const menu = document.getElementById("action-menu");
  menu.items = [
    { value: "open", label: "Open project" },
    { value: "copy", label: "Copy link", description: "Share the project with your team" },
    { value: "pin", label: "Pinned", checked: true },
    { value: "archive", label: "Archive", disabled: true },
    { value: "remove", label: "Remove", danger: true },
  ];
  menu.addEventListener("omg-select", (event) => { document.getElementById("menu-result").textContent = `Selected: ${event.detail.value}`; });
});
document.getElementById("pagination").addEventListener("omg-page-change", (event) => event.currentTarget.setAttribute("page", String(event.detail.page)));
customElements.whenDefined("omg-table").then(() => {
  const table = document.getElementById("versions-table");
  table.columns = [{ key: "version", heading: "Version" }, { key: "status", heading: "Status" }, { key: "size", heading: "Size", align: "right" }];
  table.rows = [
    { key: "v2", cells: { version: "Garden 0.2.0", status: "Draft", size: "2.4 MB" } },
    { key: "v1", cells: { version: "Garden 0.1.0", status: "Online", size: "1.8 MB" } },
  ];
});
