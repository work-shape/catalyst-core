// Stands in for the API while host/check-upload.mjs runs against it:
//
//   upload-api.mjs MODE LOG_FILE PORT_FILE
//
// Writes its port to PORT_FILE and every call to LOG_FILE as "<method> <path> <who>". MODE is
// "ready" (the second read finds the file processed), "stuck" (it stays queued), "failed",
// "no-session-tokens" or "keeps-conversation" (the delete is refused).
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [mode, logFile, portFile] = process.argv.slice(2);
const log = (line) => appendFileSync(logFile, `${line}\n`);
const conversation = "/api/v1/conversations/conv_fixture";
let reads = 0;

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const who = request.headers["x-server-credential"]
    ? "server-credential"
    : (request.headers.authorization ?? "nobody");
  log(`${request.method} ${request.url} ${who}`);
  const answer = (status, json) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(json));
  };
  const refuse = (status, message) => answer(status, { error: { code: "X", message } });
  const route = `${request.method} ${request.url}`;
  const attachment = (status) => ({
    id: "att_fixture",
    status,
    ...(status === "failed" ? { error: { message: "the converter gave up" } } : {})
  });

  if (route === "POST /api/v1/instance/session-tokens") {
    if (mode === "no-session-tokens") return refuse(404, "Session token issuing is not configured");
    if (request.headers["x-server-credential"] !== "fixture-credential") return refuse(403, "no");
    const asked = JSON.parse(body);
    log(`token for ${asked.externalUserId} with ${asked.scopes.join(",")}`);
    return answer(200, { chatSessionToken: "fixture-token", expiresAt: "2026-10-12T08:15:00Z" });
  }
  if (request.headers.authorization !== "Bearer fixture-token") return refuse(401, "no token");
  if (route === "POST /api/v1/conversations") {
    log(`title ${JSON.parse(body).title}`);
    return answer(200, { id: "conv_fixture" });
  }
  if (route === `POST ${conversation}/draft-attachments`) {
    const file = /filename="([^"]+)"/.exec(body)?.[1];
    log(`file ${file} ${body.includes("Synthetic file")}`);
    return answer(200, { attachment: attachment("queued"), attachments: [attachment("queued")] });
  }
  if (route === `GET ${conversation}/draft-attachments`) {
    reads += 1;
    const status =
      mode === "stuck"
        ? "queued"
        : reads < 2
          ? "preprocessing"
          : mode === "failed"
            ? "failed"
            : "ready";
    return answer(200, { items: [attachment(status)] });
  }
  if (route === `DELETE ${conversation}/draft-attachments/att_fixture`) {
    return answer(200, attachment("deleted"));
  }
  if (route === `DELETE ${conversation}`) {
    if (mode === "keeps-conversation") return refuse(403, "User conversation deletion is disabled");
    return answer(200, { id: "conv_fixture" });
  }
  return refuse(404, `no route ${route}`);
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(portFile, String(server.address().port));
});
