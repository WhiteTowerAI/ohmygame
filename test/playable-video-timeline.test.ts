// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  formatMediaTime,
  playableMomentContext,
} from "../src/shared/playable-chat-context.js";
import {
  isPlayableFrameMessage,
  isPlayableHostMessage,
} from "../src/shared/playable-player-protocol.js";
import { watchPlayableBackdropVideo } from "../src/shared/playable-sandbox.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Background video timeline", () => {
  it("accepts media reports and commands, and rejects malformed ones", () => {
    const media = {
      assetId: "intro",
      duration: 12,
      time: 4.2,
      paused: true,
      advancing: false,
    };
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:media",
        instanceId: "a",
        media,
      }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:media",
        instanceId: "a",
      }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:media",
        instanceId: "a",
        media: { ...media, duration: Number.NaN },
      }),
    ).toBe(false);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:media",
        instanceId: "a",
        media: { ...media, paused: "yes" },
      }),
    ).toBe(false);
    const { advancing: _advancing, ...untracked } = media;
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:media",
        instanceId: "a",
        media: untracked,
      }),
    ).toBe(false);

    for (const command of [
      { action: "play" },
      { action: "pause" },
      { action: "seek", time: 3 },
    ]) {
      expect(
        isPlayableHostMessage({
          kind: "ohmygame:playable:media-control",
          instanceId: "a",
          command,
        }),
      ).toBe(true);
    }
    for (const command of [
      { action: "seek" },
      { action: "seek", time: -1 },
      { action: "stop" },
      undefined,
    ]) {
      expect(
        isPlayableHostMessage({
          kind: "ohmygame:playable:media-control",
          instanceId: "a",
          command,
        }),
      ).toBe(false);
    }
  });

  it("describes a marked moment by its Node, Asset, and time in the file", () => {
    const context = playableMomentContext({
      nodeId: "intro",
      assetId: "intro-video",
      time: 4.2,
      duration: 12,
    });
    expect(context).toMatchObject({ kind: "playable-moment", label: "0:04.2" });
    expect(context.text).toContain(
      'background video (Asset "intro-video") of Node "intro": 4.20 s of 12.00 s',
    );
    expect(context.text).toContain(
      "screenshot shows the preview at that moment",
    );
    expect(
      playableMomentContext({ nodeId: "intro", time: 1, duration: 2 }).text,
    ).not.toContain("Asset");
  });

  it("formats times as minutes, seconds, and tenths", () => {
    expect(formatMediaTime(0)).toBe("0:00.0");
    expect(formatMediaTime(4.26)).toBe("0:04.2");
    expect(formatMediaTime(64.2)).toBe("1:04.2");
    expect(formatMediaTime(0.3)).toBe("0:00.3");
    expect(formatMediaTime(-1)).toBe("0:00.0");
  });

  it("finds the background video whenever a surface creates, replaces, or removes it", async () => {
    const layer = document.createElement("div");
    document.body.append(layer);
    const seen: (HTMLVideoElement | undefined)[] = [];
    const stop = watchPlayableBackdropVideo(layer, (video) => seen.push(video));
    expect(seen).toEqual([]);

    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      '<div class="backdrop" data-media="backdrop" data-asset="intro"></div><video class="other"></video>';
    layer.append(host);
    await flush();
    expect(seen).toEqual([]);

    const first = document.createElement("video");
    root.querySelector(".backdrop")!.append(first);
    await flush();
    expect(seen).toEqual([first]);

    const second = document.createElement("video");
    first.replaceWith(second);
    await flush();
    expect(seen).toEqual([first, second]);

    host.remove();
    await flush();
    expect(seen).toEqual([first, second, undefined]);

    stop();
    layer.append(host);
    await flush();
    expect(seen).toHaveLength(3);
    layer.remove();
  });
});
