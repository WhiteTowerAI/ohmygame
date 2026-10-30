import { describe, expect, it } from "vitest";
import { isPlayableFrameMessage } from "../src/shared/playable-player-protocol.js";

describe("Playable player protocol", () => {
  it("keeps diagnostics distinct from fatal Player errors", () => {
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:diagnostic",
        instanceId: "instance",
        error: "Cleanup failed",
      }),
    ).toBe(true);
    expect(
      isPlayableFrameMessage({
        kind: "ohmygame:playable:diagnostic",
        instanceId: "instance",
        error: 42,
      }),
    ).toBe(false);
  });
});
