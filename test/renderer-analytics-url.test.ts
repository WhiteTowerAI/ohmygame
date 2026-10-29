import { describe, expect, it } from "vitest";
import { AnalyticsUrlScrubber, analyticsPath, type AnalyticsEvent } from "../src/renderer/analytics-url.js";
import { parseAppRoute } from "../src/renderer/routes.js";

const PATHNAME = "/C:/Users/30956/AppData/Local/Programs/ohmygame/resources/app.asar/dist/renderer/index.html";
const PAGE = `file://${PATHNAME}`;

function pageview(hash: string, properties: Record<string, unknown> = {}): AnalyticsEvent {
  return {
    event: "$pageview",
    properties: { $current_url: `${PAGE}${hash}`, $pathname: PATHNAME, $prev_pageview_pathname: PATHNAME, ...properties },
  };
}

describe("analytics paths", () => {
  it("replaces ids in routes with placeholders", () => {
    expect(analyticsPath(parseAppRoute("#/"))).toBe("/");
    expect(analyticsPath(parseAppRoute("#/web-game"))).toBe("/web-game");
    expect(analyticsPath(parseAppRoute("#/projects?type=godot-game"))).toBe("/projects");
    expect(analyticsPath(parseAppRoute("#/projects/p1/conversations/c1/design"))).toBe("/projects/:id/conversations/:id/design");
    expect(analyticsPath(parseAppRoute("#/community/games/g1"))).toBe("/community/games/:id");
    expect(analyticsPath(parseAppRoute("#/plugins"))).toBe("/plugins");
    expect(analyticsPath(parseAppRoute("#/plugins/acme"))).toBe("/plugins/:id");
    expect(analyticsPath(parseAppRoute("#/settings/plugins/acme"))).toBe("/plugins/:id");
    expect(analyticsPath(parseAppRoute("#/settings/providers"))).toBe("/settings/providers");
  });
});

describe("AnalyticsUrlScrubber", () => {
  it("reports the in-app route instead of the install path", () => {
    const event = pageview("#/projects/p1");
    new AnalyticsUrlScrubber(PATHNAME).scrub(event, `${PAGE}#/projects/p1`);
    expect(event.properties).toEqual({ $current_url: "app://ohmygame/projects/:id", $pathname: "/projects/:id" });
  });

  it("tracks the previous pageview route itself", () => {
    const scrubber = new AnalyticsUrlScrubber(PATHNAME);
    scrubber.scrub(pageview("#/"), `${PAGE}#/`);
    const second = pageview("#/settings/about");
    scrubber.scrub(second, `${PAGE}#/settings/about`);
    expect(second.properties.$prev_pageview_pathname).toBe("/");
  });

  it("matches a percent-encoded install path", () => {
    const encoded = "/Applications/OhMyGame%202.app/Contents/Resources/app.asar/dist/renderer/index.html";
    const event: AnalyticsEvent = {
      event: "$autocapture",
      properties: { $pathname: decodeURI(encoded), $session_entry_pathname: encoded, $session_entry_url: `file://${encoded}#/library` },
    };
    new AnalyticsUrlScrubber(encoded).scrub(event, `file://${encoded}#/web-game`);
    expect(event.properties).toEqual({
      $pathname: "/web-game",
      $session_entry_pathname: "/library",
      $session_entry_url: "app://ohmygame/library",
    });
  });

  it("rewrites file URLs nested in person properties and element chains", () => {
    const event: AnalyticsEvent = {
      event: "$autocapture",
      properties: {
        $elements_chain: `a:href="${PAGE}#/projects/p1"nth-child="1"`,
        $elements: [{ attr__href: `${PAGE}#/community/games/g1` }],
      },
      $set_once: { $initial_person_info: { u: `${PAGE}#/`, r: "$direct" } },
    };
    new AnalyticsUrlScrubber(PATHNAME).scrub(event, `${PAGE}#/`);
    expect(event.properties.$elements_chain).toBe(`a:href="app://ohmygame/projects/:id"nth-child="1"`);
    expect(event.properties.$elements).toEqual([{ attr__href: "app://ohmygame/community/games/:id" }]);
    expect(event.$set_once).toEqual({ $initial_person_info: { u: "app://ohmygame/", r: "$direct" } });
  });

  it("keeps the build path of exception stack frames", () => {
    const asset = `${PAGE.slice(0, PAGE.lastIndexOf("/"))}/assets/index-abc.js`;
    const event: AnalyticsEvent = {
      event: "$exception",
      properties: {
        $exception_list: [{
          value: "boom",
          stacktrace: { frames: [{ filename: `${asset}:12:345` }] },
        }],
        $exception_stack: `Error: boom\n    at run (${asset}:12:345)`,
      },
    };
    new AnalyticsUrlScrubber(PATHNAME).scrub(event, `${PAGE}#/`);
    expect(event.properties.$exception_list).toEqual([{
      value: "boom",
      stacktrace: { frames: [{ filename: "app://ohmygame/assets/index-abc.js:12:345" }] },
    }]);
    expect(event.properties.$exception_stack).toBe("Error: boom\n    at run (app://ohmygame/assets/index-abc.js:12:345)");
  });

  it("hides home folders named in error messages", () => {
    const event: AnalyticsEvent = {
      event: "$exception",
      properties: {
        mac: "ENOENT: no such file, open '/Users/alice/Games/demo/project.json'",
        windows: "Cannot read C:\\Users\\30956\\Documents\\demo and /C:/Users/30956/Desktop",
        linux: "EACCES: /home/bob/demo",
        url: "https://example.com/home/feed and https://example.com/Users/1",
      },
    };
    new AnalyticsUrlScrubber(PATHNAME).scrub(event, `${PAGE}#/`);
    expect(event.properties).toEqual({
      mac: "ENOENT: no such file, open '~/Games/demo/project.json'",
      windows: "Cannot read ~\\Documents\\demo and ~/Desktop",
      linux: "EACCES: ~/demo",
      url: "https://example.com/home/feed and https://example.com/Users/1",
    });
  });
});
