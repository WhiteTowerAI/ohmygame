import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initials, UserAvatar } from "../src/renderer/user-avatar.js";

describe("UserAvatar", () => {
  it("renders the authenticated avatar without sending a referrer", () => {
    const html = renderToStaticMarkup(<UserAvatar className="avatar" name="Di Huang" avatarUrl="https://example.com/avatar.png" />);

    expect(html).toContain('src="https://example.com/avatar.png"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("falls back to name initials", () => {
    expect(initials("Di Huang")).toBe("DH");
    expect(initials(" ")).toBe("OG");
    expect(renderToStaticMarkup(<UserAvatar className="avatar" name="Di Huang" />)).toContain(">DH</span>");
  });
});
