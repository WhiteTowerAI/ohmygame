import { describe, expect, it } from "vitest";
import {
  describePlayablePick,
  playableCssPath,
  type PickableElement,
} from "../src/shared/playable-picker.js";
import {
  annotatePlayableSourceLocations,
  PLAYABLE_SOURCE_ATTRIBUTE,
} from "../src/shared/playable-source-locations.js";
import {
  isPlayableFrameMessage,
  isPlayableHostMessage,
} from "../src/shared/playable-player-protocol.js";

describe("annotatePlayableSourceLocations", () => {
  it("annotates start tags with one-based line and column", () => {
    const html = ['<main class="menu">', "  <button>Start</button>", "</main>"].join(
      "\n",
    );

    expect(annotatePlayableSourceLocations(html, "nodes/menu/index.html")).toBe(
      [
        '<main data-ohmygame-source="nodes/menu/index.html:1:1" class="menu">',
        '  <button data-ohmygame-source="nodes/menu/index.html:2:3">Start</button>',
        "</main>",
      ].join("\n"),
    );
  });

  it("leaves comments, end tags, and raw text content untouched", () => {
    const html = [
      "<!-- <p>comment</p> -->",
      "<style>a > b { content: '<div>'; }</style>",
      "<script>if (1 < 2) document.querySelector('p');</script>",
      "<textarea><span>literal</span></textarea>",
      "<p data-value=\"a>b\">1 < 2</p>",
    ].join("\n");

    const annotated = annotatePlayableSourceLocations(html, "index.html");

    expect(annotated).toContain("<!-- <p>comment</p> -->");
    expect(annotated).toContain("a > b { content: '<div>'; }");
    expect(annotated).toContain("if (1 < 2) document.querySelector('p');");
    expect(annotated).toContain("<textarea data-ohmygame-source=\"index.html:4:1\"><span>literal</span></textarea>");
    expect(annotated).toContain('<p data-ohmygame-source="index.html:5:1" data-value="a>b">');
    // style, script, textarea, and p only.
    expect(annotated.match(/data-ohmygame-source/g)).toHaveLength(4);
  });

  it("keeps an existing attribute and self-closing tags", () => {
    const html = '<img src="a.png" /><b data-ohmygame-source="other:1:1">x</b>';

    expect(annotatePlayableSourceLocations(html, "index.html")).toBe(
      '<img data-ohmygame-source="index.html:1:1" src="a.png" /><b data-ohmygame-source="other:1:1">x</b>',
    );
  });
});

describe("describePlayablePick", () => {
  it("describes the picked element with its Node, source, and CSS path", () => {
    const surface = element("div", { "data-playable-surface": "menu" });
    const list = element("ul", { [PLAYABLE_SOURCE_ATTRIBUTE]: "nodes/menu/index.html:2:3" }, surface);
    const first = element("li", {}, list);
    const second = element(
      "li",
      { [PLAYABLE_SOURCE_ATTRIBUTE]: "nodes/menu/index.html:4:5" },
      list,
      "  Open the\n archive  ",
    );
    expect(list.children).toEqual([first, second]);

    expect(describePlayablePick([second, list, surface, {}])).toEqual({
      nodeId: "menu",
      source: "nodes/menu/index.html:4:5",
      cssPath: "ul > li:nth-of-type(2)",
      tag: "li",
      text: "Open the archive",
      box: { x: 0, y: 0, width: 0, height: 0 },
    });
  });

  it("falls back to the nearest annotated ancestor and stops the path at an ID", () => {
    const surface = element("div", { "data-playable-surface": "shell" });
    const anchored = element(
      "section",
      { id: "cases", [PLAYABLE_SOURCE_ATTRIBUTE]: "shell/index.html:3:1" },
      surface,
    );
    const created = element("span", {}, anchored);

    expect(describePlayablePick([created, anchored, surface])).toMatchObject({
      nodeId: "shell",
      source: "shell/index.html:3:1",
      cssPath: "section#cases > span",
    });
  });

  it("names the Signal of the nearest data-signal element", () => {
    const surface = element("div", { "data-playable-surface": "menu" });
    const button = element("button", { "data-signal": "start" }, surface);
    const label = element("span", {}, button, "Start");

    expect(describePlayablePick([label, button, surface])).toMatchObject({ signal: "start", tag: "span" });
    expect(describePlayablePick([surface.children[0]!, surface])?.signal).toBe("start");
    expect(describePlayablePick([element("p", {}, surface), surface])?.signal).toBeUndefined();
  });

  it("marks images, videos, and data-media slots as media", () => {
    const surface = element("div", { "data-playable-surface": "menu" });
    const backdrop = element("div", { "data-media": "backdrop" }, surface);
    const image = element("img", {}, surface);
    const text = element("p", {}, surface);

    expect(describePlayablePick([backdrop, surface])).toMatchObject({ media: true, mediaSlot: "backdrop" });
    expect(describePlayablePick([image, surface])).toMatchObject({ media: true });
    expect(describePlayablePick([image, surface])?.mediaSlot).toBeUndefined();
    expect(describePlayablePick([text, surface])?.media).toBeUndefined();
  });

  it("ignores a path without a surface and a click on the surface itself", () => {
    const surface = element("div", { "data-playable-surface": "menu" });

    expect(describePlayablePick([surface, {}])).toBeUndefined();
    expect(describePlayablePick([element("p"), {}])).toBeUndefined();
    expect(describePlayablePick([])).toBeUndefined();
  });

  it("returns an unannotated element without a source", () => {
    const surface = element("div", { "data-playable-surface": "menu" });
    const created = element("p", {}, surface);

    const pick = describePlayablePick([created, surface]);

    expect(pick?.source).toBeUndefined();
    expect(playableCssPath(created)).toBe("p");
  });
});

describe("pick protocol messages", () => {
  it("accepts pick messages in both directions", () => {
    expect(
      isPlayableHostMessage({ kind: "ohmygame:playable:pick-start", instanceId: "a", tool: "text" }),
    ).toBe(true);
    expect(
      isPlayableHostMessage({ kind: "ohmygame:playable:pick-start", instanceId: "a" }),
    ).toBe(false);
    expect(
      isPlayableHostMessage({ kind: "ohmygame:playable:pick-start", instanceId: "a", tool: "draw" }),
    ).toBe(false);
    expect(
      isPlayableHostMessage({ kind: "ohmygame:playable:pick-cancel", instanceId: "a" }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:picked",
        instanceId: "a",
        pick: { nodeId: "menu" },
        additive: true,
      }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:picked",
        instanceId: "a",
        pick: { nodeId: "menu" },
      }),
    ).toBe(false);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:text-edited",
        instanceId: "a",
        edit: { pick: { nodeId: "menu" }, before: "Start", after: "Begin", inPlace: true },
      }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:text-edited",
        instanceId: "a",
        edit: { pick: { nodeId: "menu" }, before: "Start", after: "Begin" },
      }),
    ).toBe(false);
    expect(
      isPlayableHostMessage({ kind: "ohmygame:playable:pick-start", instanceId: "a", tool: "move" }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({ kind: "ohmygame:playable:seen", instanceId: "a", seen: { version: 1, nodes: {}, edges: {} } }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({ kind: "ohmygame:playable:seen", instanceId: "a", seen: [] }),
    ).toBe(false);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:moved",
        instanceId: "a",
        move: { pick: { nodeId: "menu" }, translate: { x: 2.5, y: -1 }, inPlace: true },
      }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:moved",
        instanceId: "a",
        move: { pick: { nodeId: "menu" }, translate: { x: "2.5cqw", y: 0 }, inPlace: true },
      }),
    ).toBe(false);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:pick-cancelled",
        instanceId: "a",
      }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({ kind: "ohmygame:playable:picked", instanceId: "a" }),
    ).toBe(false);
  });

  it("rejects an init message with a non-object preview", () => {
    const init = {
      kind: "ohmygame:playable:init",
      instanceId: "a",
      definition: {},
      assets: {},
    };

    expect(isPlayableHostMessage(init)).toBe(true);
    expect(isPlayableHostMessage({ ...init, preview: { policy: "report" } })).toBe(true);
    expect(isPlayableHostMessage({ ...init, preview: "report" })).toBe(false);
  });
});

interface FakeElement extends PickableElement {
  children: FakeElement[];
}

function element(
  tag: string,
  attributes: Record<string, string> = {},
  parent?: FakeElement,
  text = "",
): FakeElement {
  const node: FakeElement = {
    tagName: tag.toUpperCase(),
    id: attributes.id ?? "",
    parentElement: parent ?? null,
    textContent: text,
    children: [],
    getAttribute: (name) => attributes[name] ?? null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
  parent?.children.push(node);
  return node;
}
