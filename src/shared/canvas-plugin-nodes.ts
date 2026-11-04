import type { PluginContributions } from "./plugin-manifest.js";

// The rules a plugin's canvas node holds its settings and inputs to, shared
// by the node's form and the daemon that runs it.

export type CanvasNodeDefinition = NonNullable<PluginContributions["canvasNodes"]>[number];
export type CanvasNodeParamValue = string | number | boolean;

/** A setting's value as the node shows it: what the person chose, else the plugin's default. */
export function canvasNodeParamValue(
  param: { type: string; default?: CanvasNodeParamValue; options?: readonly string[]; minimum?: number },
  value: CanvasNodeParamValue | undefined,
): CanvasNodeParamValue {
  if (value !== undefined) return value;
  if (param.default !== undefined) return param.default;
  return param.type === "boolean" ? false : param.type === "number" ? (param.minimum ?? 0) : param.type === "select" ? param.options?.[0] ?? "" : "";
}

/**
 * The values a node's code gets: every setting the plugin declares, with
 * its default where the person chose none. Throws, naming the setting by
 * `title`, when a value doesn't fit.
 */
export function canvasNodeParams(
  definition: CanvasNodeDefinition,
  values: Record<string, CanvasNodeParamValue>,
  title: (text: string) => string = (text) => text,
): Record<string, CanvasNodeParamValue> {
  const params: Record<string, CanvasNodeParamValue> = {};
  for (const [key, param] of Object.entries(definition.params ?? {})) {
    const value = canvasNodeParamValue(param, Object.hasOwn(values, key) ? values[key] : undefined);
    const name = title(param.title);
    const expected = param.type === "boolean" ? "boolean" : param.type === "number" ? "number" : "string";
    if (typeof value !== expected || (typeof value === "number" && !Number.isFinite(value)))
      throw new Error(`${name} must be a ${expected === "string" ? "text" : expected}`);
    if (typeof value === "number" && ((param.minimum !== undefined && value < param.minimum) || (param.maximum !== undefined && value > param.maximum)))
      throw new Error(`${name} must be between ${param.minimum ?? "-∞"} and ${param.maximum ?? "∞"}`);
    if (param.type === "select" && !param.options?.includes(String(value)))
      throw new Error(`${name} must be one of: ${param.options?.join(", ")}`);
    params[key] = value;
  }
  return params;
}

/**
 * Checks the inputs against what the node takes: each required one is
 * connected, one source where it takes one, and of the type it accepts.
 * Inputs the node doesn't declare are left out.
 */
export function canvasNodeInputs<T extends { type: string }>(
  definition: CanvasNodeDefinition,
  inputs: Record<string, T[]>,
  title: (text: string) => string = (text) => text,
): Record<string, T[]> {
  const checked: Record<string, T[]> = {};
  for (const input of definition.inputs ?? []) {
    const sources = Object.hasOwn(inputs, input.id) ? inputs[input.id]! : [];
    const name = title(input.title);
    if (!sources.length && !input.optional) throw new Error(`Connect something to ${name}`);
    if (sources.length > 1 && !input.multiple) throw new Error(`${name} takes one ${input.accepts}`);
    if (sources.some((source) => source.type !== input.accepts)) throw new Error(`${name} takes ${input.accepts === "model" ? "3D model" : input.accepts} only`);
    checked[input.id] = sources;
  }
  return checked;
}
