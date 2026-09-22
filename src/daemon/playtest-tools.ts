import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlaytestAction, PlaytestDriver, PlaytestSnapshot } from "../shared/playtest.js";

const viewportSchema = Type.Object({
  width: Type.Integer({ minimum: 240, maximum: 4096 }),
  height: Type.Integer({ minimum: 240, maximum: 4096 }),
}, { additionalProperties: false });

const targetSchema = Type.Union([
  Type.Object({ selector: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
  Type.Object({ testId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
  Type.Object({ text: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
  Type.Object({
    role: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  }, { additionalProperties: false }),
  Type.Object({
    x: Type.Number({ minimum: 0, maximum: 8192 }),
    y: Type.Number({ minimum: 0, maximum: 8192 }),
  }, { additionalProperties: false }),
]);

const semanticTargetSchema = Type.Union([
  Type.Object({ selector: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
  Type.Object({ testId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
  Type.Object({ text: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
  Type.Object({
    role: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  }, { additionalProperties: false }),
]);

const actionSchema = Type.Union([
  Type.Object({ type: Type.Literal("click"), target: targetSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("type"), target: semanticTargetSchema, text: Type.String({ maxLength: 10_000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("press"), key: Type.String({ minLength: 1, maxLength: 40 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("touch"), x: Type.Number({ minimum: 0, maximum: 8192 }), y: Type.Number({ minimum: 0, maximum: 8192 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("wait"), milliseconds: Type.Integer({ minimum: 0, maximum: 5_000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("resize"), viewport: viewportSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("bridge"), method: Type.Literal("reset") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("bridge"), method: Type.Union([Type.Literal("setSeed"), Type.Literal("step")]), value: Type.Number() }, { additionalProperties: false }),
]);

const parameters = Type.Object({
  operation: Type.Union([
    Type.Literal("open"),
    Type.Literal("inspect"),
    Type.Literal("act"),
    Type.Literal("capture"),
    Type.Literal("close"),
  ]),
  path: Type.Optional(Type.String({ maxLength: 1_000, description: "Path, query, or hash within the current project preview; used only by open" })),
  viewport: Type.Optional(viewportSchema),
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Session returned by open; required for inspect, act, capture, and close" })),
  actions: Type.Optional(Type.Array(actionSchema, { minItems: 1, maxItems: 20, description: "Actions to run; required for act" })),
}, { additionalProperties: false });

export function createPlaytestTool(
  driver: PlaytestDriver,
  ensurePreview: () => Promise<string>,
): ToolDefinition<typeof parameters> {
  return defineTool<typeof parameters, unknown>({
    name: "playtest_browser",
    label: "Game Playtest",
    description: "Open and control the current browser-game preview, inspect interactive elements, canvas state, console and network failures, capture screenshots, and call an optional OhMyGame playtest bridge. Reuse the returned sessionId and close the session when finished.",
    promptSnippet: "Playtest the current browser game with real input, runtime inspection, and screenshots",
    promptGuidelines: [
      "Use playtest_browser for browser-game runtime or visual verification; a successful build alone is not a playtest",
      "Capture screenshots for Canvas or WebGL verification and close playtest sessions when finished",
    ],
    parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, input, signal) => {
      if (!driver.available) throw new Error("Browser playtesting is not available in this environment");
      if (input.operation === "open") {
        const preview = await ensurePreview();
        signal?.throwIfAborted();
        const url = previewUrl(preview, input.path);
        const result = await driver.request({
          operation: "open",
          url,
          viewport: input.viewport ?? { width: 1280, height: 720 },
        }, signal);
        if (result.operation !== "open") throw new Error("Unexpected browser playtest response");
        return snapshotResult(result.snapshot);
      }
      if (input.operation === "capture") {
        const result = await driver.request({ operation: "capture", sessionId: requiredSessionId(input.operation, input.sessionId) }, signal);
        if (result.operation !== "capture") throw new Error("Unexpected browser playtest response");
        return {
          content: [
            { type: "text", text: JSON.stringify({
              sessionId: result.capture.sessionId,
              width: result.capture.width,
              height: result.capture.height,
              analysis: result.capture.analysis,
            }, null, 2) },
            { type: "image", data: result.capture.data, mimeType: result.capture.mediaType },
          ],
          details: { playtestCapture: { ...result.capture, data: undefined } },
        };
      }
      if (input.operation === "close") {
        const sessionId = requiredSessionId(input.operation, input.sessionId);
        await driver.request({ operation: "close", sessionId }, signal);
        return { content: [{ type: "text", text: `Closed browser playtest session ${sessionId}` }], details: undefined };
      }
      const sessionId = requiredSessionId(input.operation, input.sessionId);
      const result = input.operation === "inspect"
        ? await driver.request({ operation: "inspect", sessionId }, signal)
        : await driver.request({ operation: "act", sessionId, actions: requiredActions(input.actions) }, signal);
      if (result.operation !== "inspect" && result.operation !== "act") throw new Error("Unexpected browser playtest response");
      return snapshotResult(result.snapshot);
    },
  });
}

function requiredSessionId(operation: string, sessionId?: string): string {
  if (!sessionId) throw new Error(`sessionId is required for ${operation}`);
  return sessionId;
}

function requiredActions(actions?: PlaytestAction[]): PlaytestAction[] {
  if (!actions?.length) throw new Error("actions are required for act");
  return actions;
}

export function previewUrl(baseValue: string, relativeValue?: string): string {
  const base = new URL(baseValue);
  const resolved = relativeValue ? new URL(relativeValue, base) : base;
  if (resolved.origin !== base.origin) throw new Error("Playtest path must stay inside the current project preview");
  return resolved.href;
}

function snapshotResult(snapshot: PlaytestSnapshot) {
  const compact = compactSnapshot(snapshot);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compact, null, 2) }],
    details: { playtest: snapshot },
  };
}

function compactSnapshot(snapshot: PlaytestSnapshot) {
  return {
    ...snapshot,
    elements: snapshot.elements.slice(0, 80),
    logs: snapshot.logs.slice(-30).map((log) => ({ ...log, message: log.message.slice(0, 1_000) })),
    failedRequests: snapshot.failedRequests.slice(-30),
    ...(snapshot.gameState === undefined ? {} : { gameState: boundedJson(snapshot.gameState, 20_000) }),
  };
}

function boundedJson(value: unknown, limit: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= limit) return value;
  return { truncated: true, preview: serialized.slice(0, limit) };
}
