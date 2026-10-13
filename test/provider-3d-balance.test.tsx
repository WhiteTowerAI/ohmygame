// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Model3DBalance } from "../src/shared/contracts.js";

const api = { balance: vi.fn() };
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({ model3DBalance: api.balance, MODELS_CHANGED_EVENT: "ohmygame-models-changed" }));
const { Provider3DBalance } = await import("../src/renderer/provider-3d-balance.js");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (provider: string) => act(async () => root.render(<Provider3DBalance model={{ provider, id: "connection" }} />));
const refresh = () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh API balance"]')!;
function pending() {
  let resolve!: (value: Model3DBalance) => void;
  const promise = new Promise<Model3DBalance>((done) => { resolve = done; });
  return { promise, resolve };
}

it("disables refresh during a request and recovers after a failed balance query", async () => {
  const first = pending();
  api.balance.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ balance: 0, frozen: 1.5 });
  await render("tripo");
  expect(refresh().disabled).toBe(true);
  expect(container.textContent).toContain("Loading");
  expect(api.balance).toHaveBeenCalledWith({ provider: "tripo", id: "connection" });
  await act(async () => first.resolve({ balance: 1234.5, frozen: 2 }));
  expect(container.textContent).toContain(`${(1234.5).toLocaleString(undefined, { maximumFractionDigits: 3 })} credits`);
  expect(container.textContent).toContain("2 credits frozen");
  expect(refresh().disabled).toBe(false);
  expect(refresh().textContent).toBe("");
  await act(async () => refresh().click());
  expect(container.textContent).toContain("Balance unavailable");
  expect(refresh().disabled).toBe(false);
  await act(async () => refresh().click());
  expect(container.textContent).toContain("0 credits");
  expect(container.textContent).toContain("1.5 credits frozen");
  expect(container.textContent).not.toContain("unavailable");
});

it("ignores an old provider's pending response after navigating to another provider", async () => {
  const old = pending();
  api.balance.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ balance: 9 });
  await render("meshy");
  await render("hyper3d");
  expect(container.textContent).toContain("9 credits");
  await act(async () => old.resolve({ balance: 99 }));
  expect(container.textContent).toContain("9 credits");
  expect(container.textContent).not.toContain("99 credits");
});

it("clears cached credits on credential changes and ignores obsolete requests", async () => {
  const old = pending(), updated = pending();
  api.balance.mockResolvedValueOnce({ balance: 50 }).mockReturnValueOnce(old.promise).mockReturnValueOnce(updated.promise);
  await render("meshy");
  expect(container.textContent).toContain("50 credits");
  await act(async () => refresh().click());
  expect(container.textContent).toContain("50 credits");
  await act(async () => window.dispatchEvent(new Event("ohmygame-models-changed")));
  expect(container.textContent).not.toContain("50 credits");
  await act(async () => old.resolve({ balance: 49 }));
  expect(container.textContent).not.toContain("49 credits");
  await act(async () => updated.resolve({ balance: 5 }));
  expect(container.textContent).toContain("5 credits");
});
