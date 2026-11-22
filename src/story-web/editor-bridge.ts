/**
 * Editor tools for a web story, injected by the preview proxy and never part
 * of the project or a published game. In a page the editor opened with an
 * `ohmygame-instance`, it speaks the same messages as the Playable sandbox,
 * so the Workbench's picking, text editing, moving, video timeline, and Exit
 * reports work as they do for sandboxed Scenes.
 */
import {
  isPlayableHostMessage,
  type PlayableFrameMessage,
} from "../shared/playable-player-protocol.js";
import { reportBackdropMedia, type BackdropMediaReport } from "../shared/playable-media-report.js";
import { startPlayablePicking } from "../shared/playable-picking.js";
import type { StoryWebHandle } from "./runtime.js";

const instanceId = new URLSearchParams(location.search).get("ohmygame-instance");
if (instanceId && window.parent !== window) connect(instanceId);

function connect(instance: string): void {
  let story: StoryWebHandle | undefined;
  let media: BackdropMediaReport | undefined;
  let picking: { stop: () => void } | undefined;
  const stopPicking = () => {
    picking?.stop();
    picking = undefined;
  };
  let scheduled = false;

  const configured = Array.isArray(window.__OHMYGAME_PARENT_ORIGINS__)
    ? window.__OHMYGAME_PARENT_ORIGINS__.filter((origin): origin is string => typeof origin === "string" && origin.length > 0)
    : [];
  const allowOpaqueFile = configured.includes("file:");
  const allowedOrigins = new Set(configured.filter((origin) => origin !== "file:"));
  if (location.origin && location.origin !== "null") allowedOrigins.add(location.origin);

  const ancestorOrigin = location.ancestorOrigins?.[0];
  const referrerOrigin = (() => {
    try {
      return document.referrer ? new URL(document.referrer).origin : undefined;
    } catch {
      return undefined;
    }
  })();
  const singleConfigured = !allowOpaqueFile && configured.length === 1 ? configured[0] : undefined;
  let parentOrigin: string | undefined = ancestorOrigin && allowedOrigins.has(ancestorOrigin)
    ? ancestorOrigin
    : referrerOrigin && allowedOrigins.has(referrerOrigin)
      ? referrerOrigin
      : singleConfigured
        ? singleConfigured
        : allowOpaqueFile
          ? "*"
          : configured.length === 0 && location.origin && location.origin !== "null"
            ? location.origin
            : undefined;

  const post = (message: PlayableFrameMessage) => {
    if (parentOrigin) window.parent.postMessage(message, parentOrigin);
  };
  const postSnapshot = () => {
    scheduled = false;
    if (story) post({ kind: "ohmygame:playable:snapshot", instanceId: instance, snapshot: story.runtime.snapshot() });
  };
  const attach = () => {
    if (story || !window.__OHMYGAME_STORY__) return;
    story = window.__OHMYGAME_STORY__;
    media = reportBackdropMedia(story.host, (state) => post({ kind: "ohmygame:playable:media", instanceId: instance, ...(state ? { media: state } : {}) }));
    postSnapshot();
  };

  window.addEventListener("ohmygame:story-ready", attach);
  window.addEventListener("ohmygame:story-change", () => {
    attach();
    if (scheduled) return;
    scheduled = true;
    setTimeout(postSnapshot, 0);
  });
  window.addEventListener("ohmygame:story-error", (event) => {
    const detail = (event as CustomEvent<{ message: string; fatal?: boolean }>).detail;
    post(detail.fatal
      ? { kind: "ohmygame:playable:error", instanceId: instance, error: detail.message }
      : { kind: "ohmygame:playable:diagnostic", instanceId: instance, error: detail.message });
  });
  window.addEventListener("pagehide", () => {
    stopPicking();
    media?.stop();
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      event.source !== window.parent ||
      !(allowedOrigins.has(event.origin) || ((event.origin === "null" || event.origin === "file://") && allowOpaqueFile)) ||
      !isPlayableHostMessage(event.data) ||
      event.data.instanceId !== instance
    ) return;
    if (event.origin && event.origin !== "null" && event.origin !== "file://") parentOrigin = event.origin;
    const message = event.data;
    if (message.kind === "ohmygame:playable:pick-start") {
      stopPicking();
      if (!story) return;
      picking = startPlayablePicking(story.host.projectRoot, message.tool, {
        onPick: (pick, additive) => post({ kind: "ohmygame:playable:picked", instanceId: instance, pick, additive }),
        onTextEdit: (edit) => post({ kind: "ohmygame:playable:text-edited", instanceId: instance, edit }),
        onMove: (move) => post({ kind: "ohmygame:playable:moved", instanceId: instance, move }),
        onCancel: () => {
          picking = undefined;
          post({ kind: "ohmygame:playable:pick-cancelled", instanceId: instance });
        },
      });
    } else if (message.kind === "ohmygame:playable:pick-cancel") {
      stopPicking();
    } else if (message.kind === "ohmygame:playable:media-control") {
      media?.control(message.command);
    }
  });
}
