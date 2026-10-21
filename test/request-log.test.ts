import { expect, it } from "vitest";
import { requestLogValue } from "../src/daemon/request-log.js";

it("logs the request path without its query", () => {
  expect(
    requestLogValue({
      method: "GET",
      url: "/projects/p1/files/location?path=%2FUsers%2Fsomeone%2Fsecret.txt",
      host: "127.0.0.1:43110",
      ip: "127.0.0.1",
      socket: { remotePort: 50_000 },
    }),
  ).toEqual({
    method: "GET",
    url: "/projects/p1/files/location",
    host: "127.0.0.1:43110",
    remoteAddress: "127.0.0.1",
    remotePort: 50_000,
  });
  expect(requestLogValue({ method: "GET", url: "/health" }).url).toBe(
    "/health",
  );
});
