import type { PackageManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiPackageCatalogService } from "../src/daemon/pi-packages.js";

describe("Pi package catalog", () => {
  it("verifies the pi-package keyword and reads the Pi manifest", async () => {
    const service = new PiPackageCatalogService(async (input) => {
      const url = String(input);
      if (url.includes("/-/v1/search")) {
        return new Response(JSON.stringify({
          objects: [
            { package: { name: "verified-package", version: "1.0.0" } },
            { package: { name: "not-a-pi-package", version: "1.0.0" } },
          ],
        }), { status: 200 });
      }
      if (url.endsWith("/verified-package/latest")) {
        return new Response(JSON.stringify({
          name: "verified-package",
          version: "1.0.0",
          keywords: ["pi-package"],
          pi: { skills: ["./skills"] },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "not-a-pi-package", keywords: [] }), { status: 200 });
    });

    const result = await service.list("", 1, 20);
    expect(result.packages).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.packages[0]).toMatchObject({
      name: "verified-package",
      sourceType: "npm",
      resourceTypes: ["skill"],
      compatibility: "compatible",
      installed: false,
    });
  });

  it("lists and removes configured Pi package sources without changing their identity", async () => {
    const removeAndPersist = vi.fn(async () => true);
    const packageManager = {
      listConfiguredPackages: () => [
        { source: "npm:pi-web-access", scope: "user", filtered: false },
        { source: "git:github.com/example/pi-tools", scope: "user", filtered: false },
        { source: "/tmp/local-pi-package", scope: "user", filtered: false },
        { source: "npm:project-only", scope: "project", filtered: false },
      ],
      removeAndPersist,
    } as unknown as PackageManager;
    const service = new PiPackageCatalogService(fetch, packageManager);

    expect(service.listInstalled().map(({ sourceType }) => sourceType)).toEqual(["npm", "git", "local"]);
    await service.remove("git:github.com/example/pi-tools");
    expect(removeAndPersist).toHaveBeenCalledWith("git:github.com/example/pi-tools");
  });

  it("reports registry failures instead of hiding them as unverified packages", async () => {
    const service = new PiPackageCatalogService(async (input) => {
      if (String(input).includes("/-/v1/search")) {
        return new Response(JSON.stringify({ objects: [{ package: { name: "pi-tools" } }] }), { status: 200 });
      }
      return new Response("Registry unavailable", { status: 500 });
    });

    await expect(service.list()).rejects.toThrow("Pi package manifest request failed (500)");
  });
});
