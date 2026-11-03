// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localDate, type UsageStats } from "../src/shared/usage-stats.js";

const getUsageStats = vi.fn<() => Promise<UsageStats>>();
let authState: unknown = { status: "signed-out" };
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({
  useAuth: () => ({ state: authState, openSignIn: vi.fn() }),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUsageStats,
}));
const { SettingsPage } = await import("../src/renderer/settings-page.js");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  authState = { status: "signed-out" };
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderAccount(): Promise<void> {
  await act(async () =>
    root.render(
      <SettingsPage
        section="account"
        onNavigate={() => {}}
        onSectionChange={() => {}}
      />,
    ),
  );
}

const today = localDate(Date.now());
const usage = (rows: Partial<UsageStats["rows"][number]>[]): UsageStats => ({
  projects: [{ id: "p1", name: "Dungeon" }],
  rows: rows.map((row) => ({
    date: today,
    projectId: "p1",
    provider: "anthropic",
    model: "claude-opus-5-5",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    turns: 1,
    durationMs: 0,
    ...row,
  })),
});

it("shows token use under the account even when signed out", async () => {
  getUsageStats.mockResolvedValue(
    usage([
      {
        input: 1_000,
        cacheRead: 9_000,
        output: 500,
        turns: 3,
        durationMs: 45 * 60_000,
      },
    ]),
  );

  await renderAccount();

  expect(container.textContent).toContain("Not signed in");
  expect(container.textContent).toContain("Token usage");
  expect(container.textContent).toContain("10.5K");
  expect(container.textContent).toContain("90% from cache");
  expect(container.textContent).toContain("3 turns");
  expect(container.textContent).toContain("45 min");
  expect(container.textContent).toContain("15 min per turn");
  expect(container.textContent).not.toContain("$");
  expect(container.textContent).toContain("claude-opus-5-5");
  expect(container.textContent).toContain("Dungeon");
  expect(
    container.querySelectorAll(".usage-heatmap-cell.is-level-4"),
  ).not.toHaveLength(0);
});

it("says when nothing has been used yet and keeps sharing off", async () => {
  getUsageStats.mockResolvedValue(usage([]));

  await renderAccount();

  expect(container.textContent).toContain("No usage yet");
  const share = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Share",
  );
  expect(share?.disabled).toBe(true);
});

it("opens a card to share that leaves project names out", async () => {
  getUsageStats.mockResolvedValue(usage([{ input: 2_000, output: 100 }]));
  await renderAccount();

  const share = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Share",
  )!;
  await act(async () => share.click());

  const card = document.body.querySelector(".usage-share-preview svg");
  expect(card?.textContent).toContain("OhMyGame");
  expect(card?.textContent).toContain("claude-opus-5-5");
  expect(card?.textContent).not.toContain("Dungeon");
  expect(
    [...document.body.querySelectorAll("button")].map(
      (button) => button.textContent,
    ),
  ).toEqual(expect.arrayContaining(["Copy image", "Save image"]));

  // Each layout is its own drawing size.
  const portrait = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "Portrait",
  )!;
  await act(async () => portrait.click());
  expect(
    document.body
      .querySelector(".usage-share-preview svg")
      ?.getAttribute("height"),
  ).toBe("1440");
});

async function openShare(): Promise<void> {
  const share = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Share",
  )!;
  await act(async () => share.click());
}

it("keeps the colour choice in the share dialog and remembers it for the page", async () => {
  getUsageStats.mockResolvedValue(usage([{ input: 2_000, output: 100 }]));
  await renderAccount();
  const page = () => container.querySelector(".usage") as HTMLElement;
  expect(page().style.getPropertyValue("--usage-color")).toBe(
    "var(--color-accent)",
  );
  expect(container.querySelector('[aria-label="Green"]')).toBeNull();

  await openShare();
  const green = document.body.querySelector<HTMLButtonElement>(
    '[aria-label="Green"]',
  )!;
  await act(async () => green.click());

  expect(green.getAttribute("aria-checked")).toBe("true");
  expect(localStorage.getItem("ohmygame:usage-color")).toBe("green");
  expect(page().style.getPropertyValue("--usage-color")).toBe("#22A55B");
});

it("draws the account's avatar on the card, or initials if it can't be read", async () => {
  const images: {
    crossOrigin?: string;
    src?: string;
    naturalWidth: number;
    naturalHeight: number;
    onload?: () => void;
  }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 460;
      naturalHeight = 460;
      constructor() {
        images.push(this);
      }
    },
  );
  // The app's content policy blocks fetching avatar hosts.
  const fetchAvatar = vi.fn();
  vi.stubGlobal("fetch", fetchAvatar);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,AVATAR",
  );
  const avatarUrl = "https://avatars.example/ada.png";
  authState = {
    status: "signed-in",
    user: { id: "u1", name: "Ada Lovelace", avatarUrl },
  };
  getUsageStats.mockResolvedValue(usage([{ input: 2_000, output: 100 }]));
  await renderAccount();
  await openShare();
  const card = () => document.body.querySelector(".usage-share-preview svg")!;
  const loading = images.find((image) => image.src === avatarUrl)!;

  expect(loading.crossOrigin).toBe("anonymous");
  expect(fetchAvatar).not.toHaveBeenCalledWith(
    avatarUrl,
    expect.anything(),
  );
  // Until it loads, and if it never does, the card shows initials.
  expect(card().querySelector("image")).toBeNull();
  expect(card().textContent).toContain("AL");

  await act(async () => loading.onload?.());

  expect(card().querySelector("image")?.getAttribute("href")).toBe(
    "data:image/png;base64,AVATAR",
  );
  expect(card().textContent).not.toContain("AL");
  expect(drawImage).toHaveBeenCalledWith(loading, 0, 0, 256, 256);
});

it("puts the signed-in person's name on the card unless they hide it", async () => {
  authState = { status: "signed-in", user: { id: "u1", name: "Ada Lovelace" } };
  getUsageStats.mockResolvedValue(usage([{ input: 2_000, output: 100 }]));
  await renderAccount();
  await openShare();
  const card = () => document.body.querySelector(".usage-share-preview svg")!;

  expect(card().textContent).toContain("Ada Lovelace");
  // Without an avatar the card shows initials.
  expect(card().textContent).toContain("AL");

  const toggle = [...document.body.querySelectorAll("label")].find(
    (label) => label.textContent === "Show my avatar and name",
  )!;
  await act(async () => toggle.click());

  expect(card().textContent).not.toContain("Ada Lovelace");
  expect(card().textContent).toContain("OhMyGame");
});
