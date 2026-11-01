// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangelogPanel } from "../src/renderer/changelog-panel.js";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const installed = "0.0.0-beta.4.6";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__APP_CHANGELOG__", [
    {
      version: installed,
      date: "2026-10-12",
      notes:
        "### Added\n\n- An AI plugin builder workspace. ([#205](https://github.com/WhiteTowerAI/ohmygame/pull/205))",
    },
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

const release = (version: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(".ui-collapsible-trigger")].find(
    (item) => item.querySelector(".ui-collapsible-title")?.textContent === `v${version}`,
  );
async function toggle(version: string): Promise<void> {
  await act(async () => release(version)!.click());
}

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the installed release offline with safe external links", async () => {
  await act(async () =>
    root.render(<ChangelogPanel currentVersion={installed} />),
  );
  expect(container.textContent).toContain("AI plugin builder");
  expect(release(installed)?.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).not.toContain("All releases");
  expect(container.querySelector("time")?.dateTime).toBe("2026-10-12");
  const link = container.querySelector<HTMLAnchorElement>(
    'a[href$="/pull/205"]',
  )!;
  expect(link.target).toBe("_blank");
  expect(link.rel).toContain("noreferrer");
});

it("opens new update notes first and keeps the installed release one click away", async () => {
  const update = {
    version: "0.0.0-beta.4.7",
    notes: "### Fixed\n\n- Recover previews.\n\n<script>alert(1)</script>",
  };
  await act(async () =>
    root.render(
      <ChangelogPanel currentVersion={installed} availableRelease={update} />,
    ),
  );
  expect(container.textContent).toContain("Recover previews.");
  expect(container.textContent).not.toContain("AI plugin builder");
  expect(container.querySelector("script")).toBeNull();
  await toggle(installed);
  expect(container.textContent).toContain("AI plugin builder");
});

it("handles missing notes and opens the installed version when an update disappears", async () => {
  const update = { version: "0.0.0-beta.4.7", notes: "" };
  await act(async () =>
    root.render(
      <ChangelogPanel currentVersion={installed} availableRelease={update} />,
    ),
  );
  expect(container.textContent).toContain("Release notes are unavailable");
  expect(
    container.querySelector('a[href$="/tag/v0.0.0-beta.4.7"]'),
  ).not.toBeNull();
  await act(async () =>
    root.render(<ChangelogPanel currentVersion={installed} />),
  );
  expect(container.textContent).toContain("AI plugin builder");
  expect(release(update.version)).toBeUndefined();
});

it("links to every release once there are more than it lists", async () => {
  vi.stubGlobal("__APP_CHANGELOG__", Array.from({ length: 8 }, (_, index) => ({
    version: `0.0.0-beta.4.${8 - index}`,
    date: "2026-10-12",
    notes: `- Release ${8 - index}.`,
  })));
  await act(async () =>
    root.render(<ChangelogPanel currentVersion="0.0.0-beta.4.1" />),
  );
  expect(container.querySelectorAll(".ui-collapsible")).toHaveLength(7);
  expect(release("0.0.0-beta.4.1")?.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("All releases");
});

it("labels an unknown installed version without showing another version's notes", async () => {
  await act(async () =>
    root.render(<ChangelogPanel currentVersion="0.0.0-beta.4.5" />),
  );
  expect(container.textContent).toContain("Release notes are unavailable");
  expect(container.textContent).not.toContain("AI plugin builder");
});
