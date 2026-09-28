import { describe, expect, it } from "vitest";
import {
  cloneJsonObject,
  createPlayableState,
  isJsonObject,
  isJsonValue,
  patchPlayableState,
  PlayableStateError,
  setPlayableState,
} from "../src/shared/playable-state.js";
import type { JsonObject } from "../src/shared/playable-nodes.js";

describe("Playable Project State", () => {
  it("accepts the complete JSON value model and rejects process-owned values", () => {
    expect(
      isJsonObject({ value: null, list: [true, 3, "text", { nested: false }] }),
    ).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);

    const shared = { value: true };
    expect(isJsonValue({ first: shared, second: shared })).toBe(true);

    const sparse = new Array(1);
    expect(isJsonValue(sparse)).toBe(false);

    const decorated: unknown[] & { extra?: string } = [];
    decorated.extra = "not serialized";
    expect(isJsonValue(decorated)).toBe(false);

    const symbolValue = { valid: true } as Record<PropertyKey, unknown>;
    symbolValue[Symbol("not-serialized")] = true;
    expect(isJsonValue(symbolValue)).toBe(false);
  });

  it("clones initial state and every update", () => {
    const initialState: JsonObject = {
      score: 0,
      profile: { name: "Mara" },
      clues: [],
    };
    const state = createPlayableState(initialState);
    const name = state.profile as JsonObject;
    name.name = "Changed outside";

    expect(initialState.profile).toEqual({ name: "Mara" });

    const next = setPlayableState(initialState, state, "score", 2);
    const patched = patchPlayableState(initialState, next, {
      profile: { name: "Iris" },
      clues: ["key"],
    });

    expect(state.score).toBe(0);
    expect(next.score).toBe(2);
    expect(next.profile).toEqual({ name: "Changed outside" });
    expect(patched).toEqual({
      score: 2,
      profile: { name: "Iris" },
      clues: ["key"],
    });
  });

  it("rejects undeclared top-level keys atomically", () => {
    const initialState = { score: 0 };
    const state = cloneJsonObject(initialState);

    expect(() =>
      patchPlayableState(initialState, state, { score: 1, newKey: true }),
    ).toThrowError(PlayableStateError);
    expect(() =>
      patchPlayableState(initialState, { ...state, stale: true }, { score: 1 }),
    ).toThrow('Project State key "stale"');
    expect(state).toEqual({ score: 0 });
  });
});
