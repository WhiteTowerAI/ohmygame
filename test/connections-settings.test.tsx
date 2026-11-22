// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionSummary } from "../src/shared/connections.js";

const mockConnections: ConnectionSummary[] = [
  {
    id: "mcp-1",
    displayName: "Remote",
    transport: "http",
    enabled: true,
    status: "needs-auth",
    toolCount: 0,
    configurationStatus: "needs-configuration",
  },
];

const testConnection = vi.fn();
vi.doMock("../src/renderer/api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listConnections: vi.fn(async () => mockConnections),
  readConnectionConfiguration: vi.fn(async () => ({ fields: [], values: {} })),
  testConnection,
}));

const { ConnectionsSettings } = await import("../src/renderer/connections-settings.js");

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
  vi.restoreAllMocks();
});

it("renders an authorization link only for safe http/https URLs", async () => {
  await act(async () => root.render(<ConnectionsSettings />));
  await vi.waitFor(() => {
    expect([...container.querySelectorAll("button")].find((b) => b.textContent === "Manage")).toBeDefined();
  });
  const manage = [...container.querySelectorAll("button")].find((b) => b.textContent === "Manage")!;
  await act(async () => manage.click());

  const testBtn = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Test")!;
  await vi.waitFor(() => expect(testBtn()).toBeDefined());

  testConnection.mockResolvedValueOnce({ status: "needs-auth", toolCount: 0, authorizationUrl: "javascript:alert(1)" });
  await act(async () => testBtn().click());
  expect(container.querySelector("a[href]")).toBeNull();

  testConnection.mockResolvedValueOnce({ status: "needs-auth", toolCount: 0, authorizationUrl: "https://auth.example.test/oauth" });
  await act(async () => testBtn().click());
  expect(container.querySelector("a[href]")?.getAttribute("href")).toBe("https://auth.example.test/oauth");
});
