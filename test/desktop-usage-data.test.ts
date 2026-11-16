import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { UsageDataPreference } from "../src/desktop/usage-data-preference.js";

let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "ohmygame-usage-data-"));
  file = path.join(directory, "usage-data.json");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("keeps uploads off during migration and preserves the saved choice at startup", () => {
  const preference = new UsageDataPreference(file);
  expect(preference.enabled).toBe(false);

  preference.initialize(false);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    version: 1,
    enabled: false,
  });

  const restarted = new UsageDataPreference(file);
  restarted.initialize(true);
  expect(restarted.enabled).toBe(false);

  restarted.set(true);
  expect(new UsageDataPreference(file).enabled).toBe(true);
  restarted.set(false);
  expect(new UsageDataPreference(file).enabled).toBe(false);
});

it.each(['{"version":2,"enabled":true}', "{invalid"])(
  "preserves unreadable preferences (%s)",
  (contents) => {
    writeFileSync(file, contents);
    const preference = new UsageDataPreference(file);
    preference.initialize(true);
    expect(preference.enabled).toBe(false);
    expect(() => preference.set(true)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(contents);
  },
);
