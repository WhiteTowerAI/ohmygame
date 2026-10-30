import { playScene } from "../../shared/style/components.js";

export function mount(context) {
  return playScene(context, { signal: "next" });
}
