import { describe, expect, it } from "vitest";
import {
  assertPlayableSandboxDocument,
  installPlayableSandboxCsp,
  PLAYABLE_IFRAME_SANDBOX,
  PLAYABLE_SANDBOX_CSP,
} from "../src/shared/playable-sandbox.js";

describe("Playable sandbox", () => {
  it("requires a dedicated opaque-origin iframe document", () => {
    const iframeDocument = {
      defaultView: {
        origin: "null",
        top: {},
      },
    } as unknown as Document;
    const topLevelDocument = {
      defaultView: undefined as unknown as Window,
    } as Document;
    const sameOriginFrame = {
      defaultView: {
        origin: "https://example.test",
        top: {},
      },
    } as unknown as Document;

    expect(() => assertPlayableSandboxDocument(iframeDocument)).not.toThrow();
    expect(() => assertPlayableSandboxDocument(topLevelDocument)).toThrow(
      'sandbox="allow-scripts"',
    );
    expect(() => assertPlayableSandboxDocument(sameOriginFrame)).toThrow(
      'sandbox="allow-scripts"',
    );
  });

  it("installs the required CSP before authored surfaces load", () => {
    let installed: FakeMeta | undefined;
    let contentAtInsertion: string | undefined;
    const document = {
      head: {
        querySelector() {
          return installed;
        },
        prepend(meta: FakeMeta) {
          contentAtInsertion = meta.content;
          installed = meta;
        },
      },
      createElement() {
        return { content: "", dataset: {}, httpEquiv: "" } satisfies FakeMeta;
      },
    } as unknown as Document;

    installPlayableSandboxCsp(document);
    const first = installed;
    installPlayableSandboxCsp(document);

    expect(installed).toBe(first);
    expect(contentAtInsertion).toBe(PLAYABLE_SANDBOX_CSP);
    expect(installed).toEqual({
      content: PLAYABLE_SANDBOX_CSP,
      dataset: { playableSandboxCsp: "true" },
      httpEquiv: "Content-Security-Policy",
    });
    expect(PLAYABLE_IFRAME_SANDBOX).toBe("allow-scripts");
  });

  it("rejects a sandbox document whose installed Runtime policy was changed", () => {
    const installed = {
      content: "default-src *",
      dataset: { playableSandboxCsp: "true" },
      httpEquiv: "Content-Security-Policy",
    };
    const document = {
      head: {
        querySelector() {
          return installed;
        },
      },
    } as unknown as Document;

    expect(() => installPlayableSandboxCsp(document)).toThrow(
      "Playable sandbox CSP does not match the Runtime policy.",
    );
  });
});

interface FakeMeta {
  content: string;
  dataset: Record<string, string>;
  httpEquiv: string;
}
