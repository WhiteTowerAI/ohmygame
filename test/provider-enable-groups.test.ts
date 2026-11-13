import { describe, expect, it } from "vitest";
import { canEnableUnconfiguredProvider, isProviderEnabled, providerEnablementIds } from "../src/daemon/provider-enable-groups.js";

describe("provider enablement groups", () => {
  it("keeps Hyper3D's local and cloud switches in one group", () => {
    expect(providerEnablementIds("hyper3d")).toEqual(["hyper3d", "cloud-hyper3d"]);
    expect(providerEnablementIds("cloud-hyper3d")).toEqual(["hyper3d", "cloud-hyper3d"]);
    expect(canEnableUnconfiguredProvider("hyper3d")).toBe(true);
    expect(canEnableUnconfiguredProvider("cloud-hyper3d")).toBe(true);
    expect(isProviderEnabled("hyper3d", (id) => id !== "cloud-hyper3d")).toBe(false);
    expect(isProviderEnabled("cloud-hyper3d", () => true)).toBe(true);
  });

  it("keeps standalone providers independent", () => {
    expect(providerEnablementIds("meshy")).toEqual(["meshy"]);
    expect(canEnableUnconfiguredProvider("meshy")).toBe(false);
    expect(isProviderEnabled("meshy", (id) => id === "meshy")).toBe(true);
  });
});
