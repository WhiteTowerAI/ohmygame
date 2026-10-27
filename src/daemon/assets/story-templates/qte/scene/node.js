import { showBackdrop } from "../../shared/style/components.js";

/** The key to press and how long the player has, in milliseconds. */
const KEY = " ";
const TIME_LIMIT = 3000;
/** How long the hit or miss shows before the story moves on. */
const FEEDBACK = 450;

export function mount(context) {
  const backdrop = showBackdrop(context);
  const qte = context.root.querySelector("[data-qte]");
  const press = context.root.querySelector("[data-press]");
  const time = context.root.querySelector("[data-time]");
  let done = false;
  let next;
  const finish = (signal, state) => {
    if (done) return;
    done = true;
    ring.pause();
    qte.classList.add(state);
    next = setTimeout(() => void context.navigation.emit(signal), FEEDBACK);
  };
  const hit = () => finish("success", "is-hit");
  const onKey = (event) => {
    if (event.key !== KEY) return;
    event.preventDefault();
    hit();
  };
  // The ring runs out over the time limit and turns red near the end.
  const ring = time.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: 276.5 }], { duration: TIME_LIMIT, fill: "forwards" });
  const late = setTimeout(() => qte.classList.add("is-late"), TIME_LIMIT * 0.7);
  const timer = setTimeout(() => finish("fail", "is-missed"), TIME_LIMIT);
  press.addEventListener("click", hit);
  window.addEventListener("keydown", onKey);
  return () => {
    backdrop.cleanup();
    clearTimeout(late);
    clearTimeout(timer);
    clearTimeout(next);
    ring.cancel();
    press.removeEventListener("click", hit);
    window.removeEventListener("keydown", onKey);
  };
}
