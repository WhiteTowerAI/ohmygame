import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { ignoreBrokenStdio } from "../src/desktop/stdio.js";

function streamError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

it("ignores broken pipes on stdio and rethrows other stream errors", () => {
  const stream = new EventEmitter();
  ignoreBrokenStdio([stream]);

  expect(() => stream.emit("error", streamError("EPIPE"))).not.toThrow();
  expect(() => stream.emit("error", streamError("EACCES"))).toThrow("write EACCES");
});
