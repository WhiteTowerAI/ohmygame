import { showBackdrop } from "../../shared/style/components.js";

export function mount(context) {
  const { root, session, preferences, lifecycle } = context;
  const listen = { signal: lifecycle.signal };
  const backdrop = showBackdrop(context);
  const entries = [...root.querySelectorAll(".menu [data-signal]")];
  const resume = root.querySelector("[data-continue]");
  const panels = [...root.querySelectorAll("[data-panel]")];
  const open = async (event) => {
    const { signal, newGame } = event.currentTarget.dataset;
    // A new game begins with the starting Variables.
    if (newGame !== undefined) await session.reset();
    await context.navigation.emit(signal);
  };
  // Continue is only offered when a save exists.
  if (!session.hasSave()) resume.setAttribute("aria-disabled", "true");
  else {
    resume.querySelector("small").remove();
    resume.addEventListener("click", () => session.continue(), listen);
  }
  // An entry whose Exit goes nowhere yet shows disabled.
  for (const entry of entries) {
    if (context.navigation.connected(entry.dataset.signal)) entry.addEventListener("click", open, listen);
    else entry.setAttribute("aria-disabled", "true");
  }

  // Load and Settings open over the menu; Back and Esc close them.
  const show = (name) => {
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    if (name === "load") showSlots(root.querySelector("[data-slots]"), session);
  };
  for (const opener of root.querySelectorAll("[data-open]")) {
    // Load is only offered when a slot holds a game.
    if (opener.dataset.open === "load" && !session.slots().length) opener.setAttribute("aria-disabled", "true");
    else {
      opener.querySelector("small")?.remove();
      opener.addEventListener("click", () => show(opener.dataset.open), listen);
    }
  }
  for (const close of root.querySelectorAll("[data-close]")) close.addEventListener("click", () => show(), listen);
  document.addEventListener("keydown", (event) => event.key === "Escape" && show(), listen);

  // Each slider changes one preference as it moves. Volumes go from 0 to 1.
  for (const slider of root.querySelectorAll(".menu-settings input")) {
    const shown = slider.nextElementSibling;
    const value = preferences.get()[slider.name];
    if (typeof value === "number") slider.value = String(value);
    shown.textContent = formatPreference(Number(slider.value));
    slider.addEventListener("input", () => {
      shown.textContent = formatPreference(Number(slider.value));
      void preferences.set({ [slider.name]: Number(slider.value) }).catch(() => {});
    }, listen);
  }
  return backdrop.cleanup;
}

/** Lists the slots that hold a game; one saved by another version shows but cannot be loaded. */
function showSlots(list, session) {
  list.replaceChildren(...session.slots().map((slot) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-slot";
    const number = document.createElement("b");
    number.textContent = slot.id.padStart(2, "0");
    const when = document.createElement("small");
    when.textContent = new Date(slot.savedAt).toLocaleString();
    const note = document.createElement("span");
    note.textContent = slot.incompatible ? "Saved by another version" : slot.note ?? "";
    button.append(number, when, note);
    if (slot.incompatible) button.disabled = true;
    else button.addEventListener("click", () => session.loadSlot(slot.id));
    return button;
  }));
}

function formatPreference(value) {
  return Math.round(value * 100) + "%";
}
