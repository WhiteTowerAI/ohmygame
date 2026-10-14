// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NetworkSettingsState } from "../src/shared/network-settings.js";
import { NetworkSettingsPanel } from "../src/renderer/network-settings.js";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const directState: NetworkSettingsState = {
  settings: { mode: "direct", proxyUrl: "", noProxy: "" },
  active: { source: "direct", noProxy: "" },
  detected: { source: "direct", noProxy: "" },
  requiresRestart: false,
  systemProxyAvailable: true,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "ohMyGameDesktop");
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  )!;
}

async function chooseMode(mode: string) {
  await act(async () => {
    container
      .querySelector<HTMLInputElement>(`input[value="${mode}"]`)!
      .click();
  });
}

async function enterProxy(value: string) {
  await act(async () => {
    const input =
      container.querySelector<HTMLInputElement>('input[type="url"]')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("tests manual drafts without saving and reopens with the saved mode selected", async () => {
  const manualProxy = {
    source: "manual" as const,
    httpProxy: "http://127.0.0.1:7890",
    httpsProxy: "http://127.0.0.1:7890",
    noProxy: "",
  };
  const restartApp = vi.fn(async () => {});
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: { restartApp },
  });
  let state = directState;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/test")) {
      return Response.json({
        reachable: true,
        target: "https://api.openai.com/v1/models",
        route: manualProxy,
        statusCode: 401,
        elapsedMs: 42,
      });
    }
    if (init?.method === "PUT") {
      state = {
        ...directState,
        settings: JSON.parse(String(init.body)),
        detected: manualProxy,
        requiresRestart: true,
      };
    }
    return Response.json(state);
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<NetworkSettingsPanel />));
  expect(
    [...container.querySelectorAll('input[type="radio"]')].map(
      (input) => (input as HTMLInputElement).value,
    ),
  ).toEqual(["direct", "manual", "auto"]);
  expect(
    container.querySelector<HTMLInputElement>('input[value="direct"]')!.checked,
  ).toBe(true);
  expect(button("Save").disabled).toBe(true);

  await chooseMode("manual");
  expect(button("Test connection").disabled).toBe(true);
  expect(button("Save").disabled).toBe(true);
  await enterProxy("http://127.0.0.1:7890");
  await act(async () => button("Test connection").click());
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/settings/network/test",
    expect.objectContaining({
      body: JSON.stringify({
        mode: "manual",
        proxyUrl: "http://127.0.0.1:7890",
        noProxy: "",
      }),
    }),
  );
  expect(container.textContent).toContain("api.openai.com reachable · 42 ms");
  expect(
    container.querySelector('[role="status"]')!.getAttribute("title"),
  ).toBe("HTTP 401 · Manual proxy · http://127.0.0.1:7890");
  expect(container.textContent).toContain("Unsaved changes.");
  expect(button("Test connection").title).toContain("without saving");

  await act(async () => button("Save").click());
  expect(container.textContent).toContain("Saved. Restart to apply.");
  expect(container.textContent).not.toContain("Unsaved changes.");
  expect(container.textContent).not.toContain("api.openai.com reachable");
  expect(button("Save").disabled).toBe(true);

  await act(async () => root.render(<NetworkSettingsPanel key="reopened" />));
  expect(
    container.querySelector<HTMLInputElement>('input[value="manual"]')!.checked,
  ).toBe(true);
  expect(
    container.querySelector<HTMLInputElement>('input[type="url"]')!.value,
  ).toBe("http://127.0.0.1:7890");
  expect(container.textContent).not.toContain("Current connection");
  expect(container.textContent).not.toContain("After restart");
  await enterProxy("http://127.0.0.1:7891");
  expect(container.textContent).toContain("Unsaved changes.");
  await act(async () => button("Restart now").click());
  expect(restartApp).toHaveBeenCalledOnce();
  expect(
    fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
  ).toHaveLength(1);
});

it("keeps Automatic selected when detecting a proxy requires a restart", async () => {
  const originalProxy = {
    source: "system" as const,
    httpProxy: "http://127.0.0.1:7890",
    httpsProxy: "http://127.0.0.1:7890",
    noProxy: "",
  };
  const state = {
    ...directState,
    settings: { ...directState.settings, mode: "auto" as const },
    active: originalProxy,
    detected: originalProxy,
  };
  const fetchMock = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith("/detect")
        ? {
            ...state,
            detected: {
              ...originalProxy,
              httpProxy: "http://127.0.0.1:7891",
              httpsProxy: "http://127.0.0.1:7891",
            },
            requiresRestart: true,
          }
        : state,
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<NetworkSettingsPanel />));
  expect(container.textContent).toContain(
    "Use environment proxy settings first",
  );
  await act(async () => {
    container.querySelector("summary")!.click();
    button("Detect system proxy").click();
  });
  expect(
    container.querySelector<HTMLInputElement>('input[value="auto"]')!.checked,
  ).toBe(true);
  expect(container.textContent).not.toContain("Current connection");
  expect(container.textContent).not.toContain("After restart");
  expect(container.textContent).toContain(
    "Restart the local service to apply.",
  );
  expect(container.textContent).not.toContain("Unsaved changes.");
});

it("keeps failed tests compact without changing the selected mode", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/test")
          ? {
              reachable: false,
              target: "https://api.openai.com/v1/models",
              route: { source: "direct", noProxy: "" },
              elapsedMs: 10_000,
              error: "The connection timed out.",
            }
          : directState,
      ),
    ),
  );
  await act(async () => root.render(<NetworkSettingsPanel />));
  await act(async () => button("Test connection").click());
  expect(container.textContent).toContain("The connection timed out.");
  expect(
    container.querySelector('[role="status"]')!.getAttribute("title"),
  ).toBe("HTTP — · Direct connection");
  expect(
    container.querySelector<HTMLInputElement>('input[value="direct"]')!.checked,
  ).toBe(true);
  expect(container.textContent).not.toContain("Saved.");
});

it("hides system detection when Automatic uses an environment proxy", async () => {
  const state: NetworkSettingsState = {
    ...directState,
    settings: { ...directState.settings, mode: "auto" },
    detected: {
      source: "environment",
      httpsProxy: "http://env.test:8080",
      noProxy: "",
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(state)),
  );
  await act(async () => root.render(<NetworkSettingsPanel />));
  await act(async () => container.querySelector("summary")!.click());
  expect(button("Detect system proxy")).toBeUndefined();
  await chooseMode("manual");
  expect(button("Detect system proxy")).toBeUndefined();
  await chooseMode("direct");
  expect(button("Detect system proxy")).toBeUndefined();
});
