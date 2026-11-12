import { describe, expect, it } from "vitest";
import { formatBytes } from "../src/renderer/format-bytes.js";

describe("formatBytes", () => {
  it("keeps bytes, kilobytes and megabytes in their units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1500)).toBe("2 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("does not show 1024 KB just below one megabyte", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
    expect(formatBytes(1023 * 1024 + 1)).toBe("1.0 MB");
    expect(formatBytes(1023 * 1024)).toBe("1023 KB");
  });
});
