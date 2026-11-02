// The gallery's own behaviour: moving the steps, showing command results,
// the chosen option and log lines. The components connect themselves.
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
    log.text = [...lines, `[${new Date().toLocaleTimeString()}] Line ${lines.length + 1}`].join("\n");
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
