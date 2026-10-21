import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamVertex } from "@earendil-works/pi-ai/api/google-vertex";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GOOGLE_VERTEX_MODELS } from "@earendil-works/pi-ai/providers/google-vertex.models";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vitest";
import {
  customModelCatalog,
  knownCustomModel,
  resolveCustomModelCapabilities,
} from "../src/daemon/custom-model-capabilities.js";
import {
  clampReasoningLevel,
  supportedReasoningLevels,
} from "../src/shared/reasoning.js";

const google = GOOGLE_MODELS["gemini-4-argon"];
const vertex = GOOGLE_VERTEX_MODELS["gemini-4-argon"];
const levels = ["low", "medium", "high"] as const;

describe("Gemini 4 integration", () => {
  it.each([google, vertex])(
    "loads $provider capabilities and clamps older reasoning settings",
    (model) => {
      expect(model.input).toContain("image");
      expect(model.contextWindow).toBe(1_048_576);
      expect(supportedReasoningLevels(model)).toEqual(levels);
      expect(clampReasoningLevel("off", supportedReasoningLevels(model))).toBe(
        "low",
      );
      expect(
        clampReasoningLevel("minimal", supportedReasoningLevels(model)),
      ).toBe("low");
      expect(clampReasoningLevel("max", supportedReasoningLevels(model))).toBe(
        "high",
      );
    },
  );

  it.each([google, vertex])(
    "inherits the matching protocol for a custom $provider model",
    (model) => {
      // The other Google protocol appears first to catch ambiguous ID lookup.
      const catalog = customModelCatalog(
        model === google ? [vertex, google] : [google, vertex],
      );
      const relay = {
        ...model,
        provider: "custom-gemini",
        thinkingLevelMap: undefined,
      };
      expect(knownCustomModel(model.id, model.api, catalog)).toBe(model);
      expect(
        supportedReasoningLevels(
          resolveCustomModelCapabilities(relay, catalog),
        ),
      ).toEqual(levels);
      const override = resolveCustomModelCapabilities(
        { ...relay, thinkingLevelMap: { high: null } },
        catalog,
      );
      expect(supportedReasoningLevels(override)).toEqual(["low", "medium"]);
      expect(
        resolveCustomModelCapabilities({ ...relay, reasoning: false }, catalog)
          .reasoning,
      ).toBe(false);
    },
  );

  it.each(levels)(
    "sends thinkingLevel for %s reasoning on both Google adapters",
    async (reasoning) => {
      for (const provider of ["google", "google-vertex"] as const) {
        const payloads: unknown[] = [];
        const options: SimpleStreamOptions = {
          apiKey: "test-only",
          reasoning,
          maxRetries: 0,
          onPayload: (payload) => {
            payloads.push(payload);
            // Inspect the final SDK payload before any paid request or ADC lookup.
            throw new Error("Gemini payload captured");
          },
        };
        const context = normalizeContext({
          messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }],
        });
        const response = await (
          provider === "google"
            ? streamGoogle(google, context, options)
            : streamVertex(vertex, context, options)
        ).result();
        expect(response.errorMessage).toContain("Gemini payload captured");
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          model: "gemini-4-argon",
          config: {
            thinkingConfig: { thinkingLevel: reasoning.toUpperCase() },
          },
        });
        expect(JSON.stringify(payloads[0])).not.toContain("thinkingBudget");
      }
    },
  );
});
