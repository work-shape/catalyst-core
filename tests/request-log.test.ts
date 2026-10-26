import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_REDACTION } from "@work-shape/catalyst-core";
import { createLogger } from "@work-shape/catalyst-client-assembly";
import { requestLogCases } from "./support/request-log-fixtures";

afterEach(() => vi.restoreAllMocks());

function captureStdout() {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    for (const line of String(chunk).trimEnd().split("\n")) lines.push(JSON.parse(line));
    return true;
  });
  return lines;
}

describe("request URL logging", () => {
  it.each(requestLogCases)("serializes %s", (input, expected) => {
    const lines = captureStdout();
    const logger = createLogger();
    logger.info({ req: { method: "GET", url: input } });
    logger.info({ req: { method: "GET", url: expected } });
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.req).toEqual({ method: "GET", url: expected });
  });

  it("uses the same serialization for request records, nested records, child bindings and 404 messages", () => {
    const lines = captureStdout();
    const req = {
      method: "GET",
      url: "/app-content/file-set/private-token/index.html?cursor=private-id&limit=20",
      host: "example.test",
      ip: "127.0.0.1",
      headers: { authorization: "private-header" }
    };
    const logger = createLogger();
    logger.info({ req });
    logger.info({ nested: { req } });
    logger.child({ req }).info("child");
    logger.info(`Route GET:${req.url} not found`);
    logger.child({ service: "worker" }).info("Route GET:/missing?email=private-mail not found");
    logger.child({ req: { ...req, [LOG_REDACTION]: "hidden request" } }).info("marked");

    const expected = {
      method: "GET",
      url: "/app-content/[redacted]?cursor=[redacted]&limit=20",
      host: "example.test",
      remoteAddress: "127.0.0.1"
    };
    expect(lines[0]?.req).toEqual(expected);
    expect(lines[1]?.nested).toEqual({ req: expected });
    expect(lines[2]?.req).toEqual(expected);
    expect(lines[3]?.msg).toBe(`Route GET:${expected.url} not found`);
    expect(lines[4]?.msg).toBe("Route GET:/missing?email=[redacted] not found");
    expect(lines[5]?.req).toBe("hidden request");
    expect(JSON.stringify(lines)).not.toContain("private-");
    // Logging must not change the target that routing and authorization see.
    expect(req.url).toContain("private-token");
    expect(req.headers.authorization).toBe("private-header");
  });
});
