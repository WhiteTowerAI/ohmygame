import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { executeTasksUsingMultipleRangeRequests } = require("electron-updater/out/differentialDownloader/multipleRangeDownloader.js");
const { OperationKind } = require("electron-updater/out/differentialDownloader/downloadPlanBuilder.js");

// patches/electron-updater@6.8.9.patch: a connection that drops during a multi-range
// differential download must fail the download instead of crashing the main process.
it("rejects a differential download whose multi-range response fails", () => {
  const response = Object.assign(new PassThrough(), {
    statusCode: 206,
    headers: { "content-type": "multipart/byteranges; boundary=parts" },
  });
  const downloader = {
    options: {},
    createRequestOptions: () => ({ headers: {} }),
    httpExecutor: {
      createRequest: (_options: unknown, callback: (response: unknown) => void) => ({
        end: () => callback(response),
        abort: vi.fn(),
      }),
      addErrorAndTimeoutHandlers: vi.fn(),
    },
  };
  const tasks = [
    { kind: OperationKind.DOWNLOAD, start: 0, end: 10 },
    { kind: OperationKind.DOWNLOAD, start: 20, end: 30 },
  ];
  const reject = vi.fn();
  executeTasksUsingMultipleRangeRequests(downloader, tasks, new PassThrough(), 0, reject)(0);

  const error = new Error("net::ERR_CONNECTION_CLOSED");
  expect(() => response.emit("error", error)).not.toThrow();
  expect(reject).toHaveBeenCalledWith(error);
});
