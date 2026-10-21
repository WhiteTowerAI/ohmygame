export function mount({ root }) {
  if (root.querySelector("[data-fail]")) throw new Error("Target mount failed");
  root.host.dataset.mounted = "true";
  return () => root.replaceChildren();
}
