import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));

import { DesktopUpdatePreparationError, updateFailure } from "../src/desktop/updater.js";

describe("desktop update errors", () => {
  it("turns transport failures into actionable check errors", () => {
    expect(updateFailure(new Error("connect ECONNREFUSED https://updates.example/latest.yml?token=secret"), "check", "check")).toEqual({
      type: "error",
      phase: "check",
      code: "network",
      title: "Could not check for updates",
      message: "Check the network or proxy settings, then try again. The current version is still available.",
      detail: "Error: connect ECONNREFUSED https://updates.example/latest.yml?[redacted]",
      retry: "check",
      dataSafe: true,
    });
  });

  it.each([
    "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_INTERNET_DISCONNECTED",
    "net::ERR_NETWORK_CHANGED",
    "net::ERR_CONNECTION_TIMED_OUT",
    "net::ERR_ADDRESS_UNREACHABLE",
    "net::ERR_PROXY_CONNECTION_FAILED",
    "net::ERR_TUNNEL_CONNECTION_FAILED",
    "net::ERR_CERT_AUTHORITY_INVALID",
    "getaddrinfo EAI_AGAIN updates.example",
    "EAI_AGAIN updates.example",
    "Host not found",
  ])("recognizes Electron and Chromium transport error %s", (message) => {
    expect(updateFailure(new Error(message), "check", "check")).toMatchObject({
      phase: "check",
      code: "network",
      title: "Could not check for updates",
      retry: "check",
      dataSafe: true,
    });
  });

  it("distinguishes verification, storage, and safe-shutdown failures", () => {
    expect(updateFailure(new Error("sha512 checksum mismatch"), "download", "download", "1.2.0")).toMatchObject({
      code: "verification",
      retry: "download",
      version: "1.2.0",
    });
    expect(updateFailure(new Error("ENOSPC: no space left on device"), "download", "download")).toMatchObject({
      code: "storage",
    });
    expect(updateFailure(new DesktopUpdatePreparationError("save", "Workspace conflict"), "prepare", "install")).toMatchObject({
      code: "save",
      retry: "install",
    });
    expect(updateFailure(new DesktopUpdatePreparationError("shutdown", "Daemon did not exit"), "prepare", "install")).toMatchObject({
      code: "shutdown",
      retry: "install",
    });
    expect(updateFailure(new Error("spawn failed"), "install", "install", "1.2.0")).toMatchObject({
      code: "installer",
      retry: "install",
      version: "1.2.0",
    });
  });
});
