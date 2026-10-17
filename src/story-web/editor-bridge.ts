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

  const post = (message: PlayableFrameMessage) => window.parent.postMessage(message, "*");
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
    if (event.source !== window.parent || !isPlayableHostMessage(event.data) || event.data.instanceId !== instance) return;
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
