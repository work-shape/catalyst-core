import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

// A REST interface in this process, for the tests of the Connector type `http_api`: it keeps
// every request it was sent, and answers each by the test's own handler.

interface RecordedRequest {
  method: string;
  /** Path and query, as sent. */
  url: string;
  headers: IncomingHttpHeaders;
}

export type RestHandler = (request: RecordedRequest, response: ServerResponse) => void;

export interface RestTestServer {
  port: number;
  requests: RecordedRequest[];
  /** Answers every later request. */
  answer(handler: RestHandler): void;
  close(): Promise<void>;
}

/** Answers with JSON and the status given. */
export const json =
  (body: unknown, status = 200): RestHandler =>
  (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

/** Answers with the status alone. */
export const status =
  (code: number, headers: Record<string, string> = {}): RestHandler =>
  (_request, response) => {
    response.writeHead(code, headers);
    response.end();
  };

export async function startRestTestServer(
  handler: RestHandler = json({})
): Promise<RestTestServer> {
  const requests: RecordedRequest[] = [];
  let current = handler;
  const server = createServer((request, response) => {
    const recorded = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers
    };
    requests.push(recorded);
    request.resume();
    request.once("end", () => current(recorded, response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port");
  return {
    port: address.port,
    requests,
    answer(next) {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
