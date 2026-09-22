import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryChapter, StoryNode, StoryPlayerConfig } from "../src/shared/contracts.js";
import { InteractiveDramaPlayer } from "../src/renderer/playtest.js";
import { StorySurfaceViewport } from "../src/renderer/story-surface-viewport.js";
import { DEFAULT_SCENE_SURFACE_FILES, DEFAULT_STORY_PLAYER_CONFIG } from "../src/shared/story.js";

const NOOP = () => undefined;

afterEach(() => vi.unstubAllGlobals());

describe("story player viewport", () => {
  it("uses one project-sized stage for the complete player", () => {
    const chapter: StoryChapter = { id: "chapter", title: "Chapter", nodes: [], edges: [] };
    const config: StoryPlayerConfig = {
      ...DEFAULT_STORY_PLAYER_CONFIG,
      viewport: { width: 1024, height: 576 },
    };
    const html = renderToStaticMarkup(<InteractiveDramaPlayer
      chapter={chapter}
      variables={[]}
      config={config}
      runtime={{ mode: "playing", chapterId: chapter.id, nodeId: "missing", variables: {} }}
      paused={false}
      hasCheckpoint={false}
      onAdvanceOpenUi={NOOP}
      onContinueGame={NOOP}
      onPause={NOOP}
      onResume={NOOP}
      onRestartCheckpoint={NOOP}
      onRestartGame={NOOP}
      onMenu={NOOP}
      onSceneTime={NOOP}
      onMediaComplete={NOOP}
      onInteraction={NOOP}
      onChoice={NOOP}
    />);

    expect(html.match(/story-player-viewport/g)).toHaveLength(1);
    expect(html.match(/story-player-stage/g)).toHaveLength(1);
    expect(html).toContain('class="story-player-stage" style="width:1024px;height:576px;transform:translate(-50%, -50%) scale(1)"');
    expect(html).not.toContain("--story-viewport-");
  });

  it("does not inject a Continue button into an empty Scene", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { appearance: "light" } } });
    const scene: StoryNode = { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Quiet scene", durationMs: 3_000, presentation: { media: { items: [] }, surface: { files: DEFAULT_SCENE_SURFACE_FILES } } } };
    const chapter: StoryChapter = { id: "chapter", title: "Chapter", nodes: [scene], edges: [] };
    const html = renderToStaticMarkup(<InteractiveDramaPlayer
      chapter={chapter}
      variables={[]}
      config={DEFAULT_STORY_PLAYER_CONFIG}
      node={scene}
      runtime={{ mode: "playing", chapterId: chapter.id, nodeId: scene.id, variables: {}, scenePlayback: { mediaId: scene.id, timeMs: 0 } }}
      paused={false}
      hasCheckpoint={false}
      onAdvanceOpenUi={NOOP}
      onContinueGame={NOOP}
      onPause={NOOP}
      onResume={NOOP}
      onRestartCheckpoint={NOOP}
      onRestartGame={NOOP}
      onMenu={NOOP}
      onSceneTime={NOOP}
      onMediaComplete={NOOP}
      onInteraction={NOOP}
      onChoice={NOOP}
    />);

    expect(html).not.toContain("story-player-continue");
    expect(html).not.toContain(">Continue<");
  });

  it("shows the runtime pause actions in Preview", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { appearance: "light" } } });
    const scene: StoryNode = { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Scene", durationMs: 3_000, presentation: { media: { items: [] }, surface: { files: DEFAULT_SCENE_SURFACE_FILES } } } };
    const chapter: StoryChapter = { id: "chapter", title: "Chapter", nodes: [scene], edges: [] };
    const html = renderToStaticMarkup(<InteractiveDramaPlayer
      chapter={chapter}
      variables={[]}
      config={DEFAULT_STORY_PLAYER_CONFIG}
      node={scene}
      runtime={{ mode: "playing", chapterId: chapter.id, nodeId: scene.id, variables: {}, scenePlayback: { mediaId: scene.id, timeMs: 0 } }}
      paused
      hasCheckpoint
      onAdvanceOpenUi={NOOP}
      onContinueGame={NOOP}
      onPause={NOOP}
      onResume={NOOP}
      onRestartCheckpoint={NOOP}
      onRestartGame={NOOP}
      onMenu={NOOP}
      onSceneTime={NOOP}
      onMediaComplete={NOOP}
      onInteraction={NOOP}
      onChoice={NOOP}
    />);

    expect(html).toContain("Resume");
    expect(html).toContain("Restart checkpoint");
    expect(html).toContain("Restart game");
    expect(html).toContain("Main menu");
    expect(html).not.toContain("Restart preview");
  });

  it("lets a surface fill the shared stage without applying another scale", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { appearance: "light" } } });
    const html = renderToStaticMarkup(<StorySurfaceViewport
      iframeRef={createRef<HTMLIFrameElement>()}
      title="Scene code"
      src="scene-surface.html"
      onLoad={NOOP}
    />);

    expect(html).toContain('src="scene-surface.html?color-scheme=light"');
    expect(html).toContain("position:absolute;inset:0;width:100%;height:100%");
    expect(html).not.toContain("transform:");
  });
});
