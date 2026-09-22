import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let runtimeSource = "";

beforeAll(async () => {
  runtimeSource = await readFile(new URL("../public/screen-surface.html", import.meta.url), "utf8");
});

describe("Screen surface layout runtime", () => {
  it("applies layout offsets without replacing authored transforms", () => {
    const properties = new Map<string, string>();
    const applyElementOffset = loadRuntimeFunction<(element: { style: { setProperty(name: string, value: string): void } }, offset: { offsetX: number; offsetY: number }) => void>("applyElementOffset");

    applyElementOffset({ style: { setProperty: (name, value) => properties.set(name, value) } }, { offsetX: 120, offsetY: -40 });

    expect(properties.get("--ohmygame-layout-translate")).toBe("120px -40px");
  });

  it("keeps part of a moved element inside the logical viewport", () => {
    const clampOffset = loadRuntimeFunction<(base: { left: number; right: number; top: number; bottom: number }, offsetX: number, offsetY: number) => { offsetX: number; offsetY: number }>("clampOffset", { innerWidth: 1280, innerHeight: 720 });
    const base = { left: 500, right: 700, top: 250, bottom: 350 };

    expect(clampOffset(base, 2_000, -2_000)).toEqual({ offsetX: 764, offsetY: -334 });
    expect(clampOffset(base, 2_100, -2_100)).toEqual({ offsetX: 764, offsetY: -334 });
  });
});

function loadRuntimeFunction<T>(name: string, dependencies: Record<string, unknown> = {}): T {
  const source = extractFunction(runtimeSource, name);
  const names = Object.keys(dependencies);
  return Function(...names, `return (${source});`)(...Object.values(dependencies)) as T;
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing runtime function: ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Incomplete runtime function: ${name}`);
}
