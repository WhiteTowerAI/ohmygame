import { playScript } from "../../shared/vn/player.js";
import script from "./script.txt";

export function mount(context) {
  return playScript(context, script, { source: "nodes/{{id}}/script.txt" });
}
