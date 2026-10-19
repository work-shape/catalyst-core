// The fixture's only external system. Count attempts, including unsuccessful deliveries,
// without retaining headers or bodies. This is a local mock, never a product endpoint.
import { createServer, request } from "node:http";
let attempts = 0;
const upstream = new URL(process.env.STORY_SAMPLE_UPSTREAM);
if (upstream.hostname !== "127.0.0.1") throw new Error("Mock upstream must be owned loopback");
const server = createServer((incoming, outgoing) => {
  if (incoming.url === "/__story_attempts" && incoming.method === "GET") {
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ attempts }));
    return;
  }
  attempts++;
  const forwarded = request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
      timeout: 10_000
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    }
  );
  forwarded.on("timeout", () => forwarded.destroy());
  forwarded.on("error", () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(forwarded);
});
server.listen(Number(process.env.STORY_SAMPLE_PORT), "127.0.0.1");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
