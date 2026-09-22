import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageQueue } from "../src/renderer/message-queue.js";

describe("MessageQueue", () => {
  it("offers edit, steer, and remove actions for queued messages", () => {
    const html = renderToStaticMarkup(
      createElement(MessageQueue, {
        items: [{
          turnId: "turn-1",
          prompt: "Add a pause menu",
          mentions: [],
          references: [],
          images: [],
          attachments: [],
        }],
        disabled: false,
        onEdit: () => undefined,
        onSteer: () => undefined,
        onRemove: () => undefined,
      }),
    );

    expect(html).toContain("Add a pause menu");
    expect(html).toContain('aria-label="Edit queued message"');
    expect(html).toContain("Steer");
    expect(html).toContain('aria-label="Remove queued message"');
  });
});
