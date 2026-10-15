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
  expect(container.textContent).toContain(`v${installed}`);
  expect(container.textContent).not.toContain("Installed version");
  expect(container.textContent).not.toContain("All releases");
  expect(container.querySelector("select")).toBeNull();
  expect(container.querySelector("time")?.dateTime).toBe("2026-10-12");
  const link = container.querySelector<HTMLAnchorElement>(
    'a[href$="/pull/205"]',
  )!;
  expect(link.target).toBe("_blank");
  expect(link.rel).toContain("noreferrer");
});

it("shows new update notes and lets the user switch back to the installed release", async () => {
  const release = {
    version: "0.0.0-beta.4.7",
    notes: "### Fixed\n\n- Recover previews.\n\n<script>alert(1)</script>",
  };
  await act(async () =>
    root.render(
      <ChangelogPanel currentVersion={installed} availableRelease={release} />,
    ),
  );
  expect(container.textContent).toContain("Recover previews.");
  expect(container.querySelector("select")?.value).toBe(release.version);
  expect(container.querySelector("script")).toBeNull();
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = installed;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("AI plugin builder");
  expect(container.textContent).not.toContain("Recover previews.");
});

it("handles missing notes and falls back to the installed version when an update disappears", async () => {
  const release = { version: "0.0.0-beta.4.7", notes: "" };
  await act(async () =>
    root.render(
      <ChangelogPanel currentVersion={installed} availableRelease={release} />,
    ),
  );
  expect(container.textContent).toContain("Release notes are unavailable");
  expect(
    container.querySelector('a[href$="/tag/v0.0.0-beta.4.7"]'),
  ).not.toBeNull();
  const select = container.querySelector("select")!;
  await act(async () =>
    select.dispatchEvent(new Event("change", { bubbles: true })),
  );
  await act(async () =>
    root.render(<ChangelogPanel currentVersion={installed} />),
  );
  expect(container.textContent).toContain("AI plugin builder");
  expect(container.querySelector("select")).toBeNull();
  expect(container.textContent).toContain(`v${installed}`);
});

it("labels an unknown installed version without showing another version's notes", async () => {
  await act(async () =>
    root.render(<ChangelogPanel currentVersion="0.0.0-beta.4.5" />),
  );
  expect(container.textContent).toContain("Release notes are unavailable");
  expect(container.textContent).not.toContain("AI plugin builder");
});
