// Local test endpoints only. The fixture certificate is trusted exclusively by the probe process.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { connect } from "node:net";

const sockets = new Set();
const tunnels = [];
let diagnosticAuthorized = false;
function serve(request, response) {
  request.resume();
  if (request.url.startsWith("/openai")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
    );
  } else if (request.url.startsWith("/anthropic")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "probe",
        type: "message",
        role: "assistant",
        model: "probe",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  } else if (request.url.startsWith("/gemini")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
  } else if (request.url === "/v1/models") {
    diagnosticAuthorized ||= Boolean(request.headers.authorization);
    response.writeHead(401);
    response.end();
  } else {
    response.end("ok");
  }
}
const ipv4 = createServer(serve);
const ipv6 = createServer(serve);
const secure = createSecureServer(
  {
    key: await readFile(new URL("./key.pem", import.meta.url)),
    cert: await readFile(new URL("./cert.pem", import.meta.url)),
  },
  serve,
);
const proxy = createServer();
const servers = [ipv4, ipv6, secure, proxy];
for (const server of servers)
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
secure.on("upgrade", (request, socket) => {
  const accept = createHash("sha1")
    .update(
      request.headers["sec-websocket-key"] +
        "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
    )
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", () => socket.end(Buffer.from([0x88, 0])));
});
const port = (server) => server.address().port;
proxy.on("connect", (request, client, head) => {
  tunnels.push(request.url);
  const upstream = connect(
    request.url.endsWith(":443") ? port(secure) : port(ipv4),
    "127.0.0.1",
    () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    },
  );
  sockets.add(upstream);
  upstream.on("close", () => sockets.delete(upstream));
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
for (const server of servers) {
  server.listen(0, server === ipv6 ? "::1" : "127.0.0.1");
  await once(server, "listening");
}
process.send({ ipv4: port(ipv4), ipv6: port(ipv6), proxy: port(proxy) });
process.on("message", () => process.send({ tunnels, diagnosticAuthorized }));
process.once("SIGTERM", async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
  process.exit(0);
});
