import { showBackdrop } from "../../shared/style/components.js";

export function mount(context) {
  const backdrop = showBackdrop(context);
  const spots = [...context.root.querySelectorAll("[data-signal]")];
  const open = (event) => context.navigation.emit(event.currentTarget.dataset.signal);
  for (const spot of spots) spot.addEventListener("click", open);
  return () => {
    backdrop.cleanup();
    for (const spot of spots) spot.removeEventListener("click", open);
  };
}
