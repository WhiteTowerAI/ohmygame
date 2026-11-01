// The gallery's own behaviour: moving the steps, showing command results,
// the chosen option and log lines. The components connect themselves.
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

const result = document.getElementById("result");
document.addEventListener("omg-command-result", (event) => {
  result.setAttribute("tone", "good");
  result.textContent = `“${event.detail.command}” finished: ${JSON.stringify(event.detail.result)}`;
});
document.addEventListener("omg-command-error", (event) => {
  result.setAttribute("tone", "bad");
  result.textContent = `“${event.detail.command}” failed.`;
});

const select = document.getElementById("select");
const chosen = document.getElementById("chosen");
const showChoice = () => (chosen.textContent = `Value: “${select.value}”`);
select.addEventListener("change", showChoice);
customElements.whenDefined("omg-select").then(showChoice);
