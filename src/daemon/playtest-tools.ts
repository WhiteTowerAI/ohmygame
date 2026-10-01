import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type {
  GameRuntimeAdapter,
  GameUseInputCapability,
  GameUseObservationCapability,
  GameUseOpenTarget,
  GameUseSnapshot,
  PlaytestAction,
  PlaytestSnapshot,
} from "../shared/playtest.js";

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

const resetBridgeAction = Type.Object({ type: Type.Literal("bridge"), method: Type.Literal("reset") }, { additionalProperties: false });
const valueBridgeAction = Type.Object({ type: Type.Literal("bridge"), method: Type.Union([Type.Literal("setSeed"), Type.Literal("step")]), value: Type.Number() }, { additionalProperties: false });

const inputActions = [
  Type.Object({ type: Type.Literal("click"), target: targetSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("type"), target: semanticTargetSchema, text: Type.String({ maxLength: 10_000 }) }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("press"),
    key: Type.String({ minLength: 1, maxLength: 40 }),
    duration: Type.Optional(Type.Integer({ minimum: 0, maximum: 5_000, description: "How long to hold the key before releasing it, in milliseconds" })),
  }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("touch"), x: Type.Number({ minimum: 0, maximum: 8192 }), y: Type.Number({ minimum: 0, maximum: 8192 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("wait"), milliseconds: Type.Integer({ minimum: 0, maximum: 5_000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("resize"), viewport: viewportSchema }, { additionalProperties: false }),
] as const;

const actionSchema = Type.Union([...inputActions, resetBridgeAction, valueBridgeAction]);

const parameters = gameUseParameters(actionSchema);

/**
 * The Playable Nodes player's bridge only resets, so its agent is not offered
 * setSeed or step; a web game may implement all of them.
 */
const resetOnlyParameters = gameUseParameters(Type.Union([...inputActions, resetBridgeAction])) as unknown as typeof parameters;

function gameUseParameters<Action extends TSchema>(action: Action) {
  return Type.Object({
    operation: Type.Union([
      Type.Literal("open"),
      Type.Literal("inspect"),
      Type.Literal("act"),
      Type.Literal("capture"),
      Type.Literal("close"),
    ]),
    path: Type.Optional(Type.String({ maxLength: 1_000, description: "Path, query, or hash within a web game target; used only by open" })),
    viewport: Type.Optional(viewportSchema),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Session returned by open; required for inspect, act, capture, and close" })),
    actions: Type.Optional(Type.Array(action, { minItems: 1, maxItems: 20, description: "Actions to run; required for act" })),
  }, { additionalProperties: false });
}

export function createGameUseTool(
  driver: GameRuntimeAdapter,
  resolveOpenTarget: () => Promise<GameUseOpenTarget>,
  { bridge = "full" }: { bridge?: "full" | "reset" } = {},
): ToolDefinition<typeof parameters> {
  return defineTool<typeof parameters, unknown>({
    name: "game_use",
    label: "Game Use",
    description: "Use the current game runtime as a player: open and control the game, inspect interactive elements and canvas state, capture screenshots, review console and network failures, and call an optional deterministic game bridge. Open and act return a fresh state snapshot. Reuse the returned sessionId and close the session when finished.",
    promptSnippet: "Use the current game with real player input, runtime inspection, and screenshots",
    promptGuidelines: [
      "Use game_use for game runtime or visual verification; a successful build alone is not a playtest",
      "Batch adjacent input and wait steps into one act call; open and act already return fresh state, so inspect only when a separate refresh is needed",
      "Capture screenshots for Canvas or WebGL verification and close playtest sessions when finished",
    ],
    parameters: bridge === "reset" ? resetOnlyParameters : parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, input, signal) => {
      if (!driver.available) throw new Error("Game use is not available in this environment");
      if (input.operation === "open") {
        const target = await resolveOpenTarget();
        signal?.throwIfAborted();
        if (target.runtime !== driver.capabilities.runtime) {
          throw new Error(`Game target runtime ${target.runtime} does not match adapter runtime ${driver.capabilities.runtime}`);
        }
        const resolvedTarget = input.path
          ? withOpenPath(target, input.path)
          : target;
        const result = await driver.request({
          operation: "open",
          target: resolvedTarget,
          viewport: input.viewport ?? { width: 1280, height: 720 },
        }, signal);
        if (result.operation !== "open") throw new Error("Unexpected game use response");
        return snapshotResult(result.snapshot);
      }
      if (input.operation === "capture") {
        requireCapability(driver, "screenshot", "observation");
        const result = await driver.request({ operation: "capture", sessionId: requiredSessionId(input.operation, input.sessionId) }, signal);
        if (result.operation !== "capture") throw new Error("Unexpected game use response");
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
        return { content: [{ type: "text", text: `Closed game session ${sessionId}` }], details: undefined };
      }
      const sessionId = requiredSessionId(input.operation, input.sessionId);
      const result = input.operation === "inspect"
        ? await driver.request({ operation: "inspect", sessionId }, signal)
        : await driver.request({ operation: "act", sessionId, actions: supportedActions(driver, requiredActions(input.actions)) }, signal);
      if (result.operation !== "inspect" && result.operation !== "act") throw new Error("Unexpected game use response");
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

function withOpenPath(target: GameUseOpenTarget, path: string): GameUseOpenTarget {
  if (target.runtime !== "web") throw new Error("path is only supported by the web game runtime");
  return { ...target, url: previewUrl(target.url, path) };
}

function supportedActions(driver: GameRuntimeAdapter, actions: PlaytestAction[]): PlaytestAction[] {
  for (const action of actions) {
    const required = actionCapabilities(action);
    const missingInput = required.input.filter((capability) => !driver.capabilities.input.includes(capability));
    if (missingInput.length > 0) throw new Error(`Game runtime does not support ${missingInput.join(" and ")} input for ${action.type}`);
    const missingObservation = required.observation.filter((capability) => !driver.capabilities.observation.includes(capability));
    if (missingObservation.length > 0) throw new Error(`Game runtime does not support ${missingObservation.join(" and ")} observation for ${action.type}`);
  }
  return actions;
}

function actionCapabilities(action: PlaytestAction): { input: GameUseInputCapability[]; observation: GameUseObservationCapability[] } {
  switch (action.type) {
    case "click": return { input: ["pointer"], observation: "x" in action.target ? [] : ["dom"] };
    case "type": return { input: ["text"], observation: ["dom"] };
    case "press": return { input: ["keyboard"], observation: [] };
    case "touch": return { input: ["touch"], observation: [] };
    case "resize": return { input: ["resize"], observation: [] };
    case "wait":
    case "bridge": return { input: [], observation: [] };
  }
}

function requireCapability(
  driver: GameRuntimeAdapter,
  capability: GameUseInputCapability | GameUseObservationCapability,
  kind: "input" | "observation",
): void {
  const available: readonly string[] = kind === "input" ? driver.capabilities.input : driver.capabilities.observation;
  if (!available.includes(capability)) throw new Error(`Game runtime does not support ${capability} ${kind}`);
}

function snapshotResult(snapshot: GameUseSnapshot) {
  const compact = compactSnapshot(snapshot);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compact, null, 2) }],
    details: { playtest: snapshot },
  };
}

function compactSnapshot(snapshot: GameUseSnapshot) {
  const webSnapshot = isPlaytestSnapshot(snapshot) ? snapshot : undefined;
  return {
    ...snapshot,
    ...(webSnapshot ? { elements: webSnapshot.elements.slice(0, 80) } : {}),
    ...(webSnapshot ? { logs: webSnapshot.logs.slice(-30).map((log) => ({ ...log, message: log.message.slice(0, 1_000) })) } : {}),
    ...(webSnapshot ? { failedRequests: webSnapshot.failedRequests.slice(-30) } : {}),
    ...(snapshot.gameState === undefined ? {} : { gameState: boundedJson(snapshot.gameState, 20_000) }),
  };
}

function isPlaytestSnapshot(snapshot: GameUseSnapshot): snapshot is PlaytestSnapshot {
  return "url" in snapshot && "elements" in snapshot && "logs" in snapshot && "failedRequests" in snapshot;
}

function boundedJson(value: unknown, limit: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= limit) return value;
  return { truncated: true, preview: serialized.slice(0, limit) };
}
