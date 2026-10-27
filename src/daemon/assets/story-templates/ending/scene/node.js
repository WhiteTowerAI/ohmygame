import { showBackdrop } from "../../shared/style/components.js";

export function mount(context) {
  const backdrop = showBackdrop(context);
  const again = context.root.querySelector("[data-restart]");
  const restart = () => context.session.restart();
  again.addEventListener("click", restart);
  return () => {
    again.removeEventListener("click", restart);
    backdrop.cleanup();
  };
}
