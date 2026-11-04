import { Code } from "typebox/compile";
import type { Plugin } from "vite";
import * as validators from "../src/shared/canvas-validators.js";

export function canvasValidatorPlugin(): Plugin {
  const prefix = "virtual:canvas-validator/";
  return {
    name: "canvas-validators",
    enforce: "pre",
    resolveId(id) {
      if (id.startsWith(prefix)) return "\0" + id;
    },
    load(id) {
      if (id.endsWith("/src/shared/canvas-validators.ts")) {
        return Object.keys(validators)
          .map((name) => `export * as ${name} from "${prefix}${name}";`)
          .join("\n");
      }
      if (!id.startsWith("\0" + prefix)) return;
      const name = id.slice(prefix.length + 1) as keyof typeof validators;
      const { Code: source, External } = Code(validators[name].Schema());
      const patterns = External.variables.map((value: unknown) => {
        if (!(value instanceof RegExp))
          throw new Error(`Unsupported external in ${name}`);
        return value.toString();
      });
      return `${source}\nSetExternal({ variables: [${patterns.join(",")}] });`;
    },
  };
}
