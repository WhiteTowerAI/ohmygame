import { showBackdrop } from "../../shared/style/components.js";

export function mount(context) {
  const backdrop = showBackdrop(context);
  const choices = context.root.querySelector(".choices");
  const options = [...context.root.querySelectorAll("[data-signal]")];
  const choose = (option) => {
    if (choices.classList.contains("is-made")) return;
    choices.classList.add("is-made");
    option.classList.add("is-picked");
    void context.navigation.emit(option.dataset.signal);
  };
  const onClick = (event) => choose(event.currentTarget);
  // Number keys pick the answer with that number.
  const onKey = (event) => {
    const option = options[Number(event.key) - 1];
    if (option) choose(option);
  };
  for (const option of options) option.addEventListener("click", onClick);
  window.addEventListener("keydown", onKey);
  return () => {
    backdrop.cleanup();
    for (const option of options) option.removeEventListener("click", onClick);
    window.removeEventListener("keydown", onKey);
  };
}
