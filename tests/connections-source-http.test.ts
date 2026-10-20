import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { sourceHttpTransport } from "@work-shape/catalyst-connections";

describe("bounded source HTTP transport", () => {
  it("pins the address, preserves the host and caps each read without following redirects", async () => {
    const hosts: string[] = [];
    const server = createServer((request, reply) => {
      hosts.push(request.headers.host ?? "");
      if (request.url === "/redirect") {
        reply.writeHead(302, { location: "https://never-contact.example.test/private?key=secret" });
        reply.end();
        return;
      }
      reply.writeHead(200, { "content-length": "10", "set-cookie": "must-not-escape" });
      reply.end("0123456789");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const grant = {
      protocol: "http",
      host: "box-download.example.test",
      port: address.port,
      address: "127.0.0.1",
      family: 4,
      network: "private"
    } as const;
    try {
      const response = await sourceHttpTransport({
        url: new URL(`http://ignored.invalid:${address.port}/file`),
        grant,
        method: "GET",
        headers: {},
        signal: new AbortController().signal
      });
      try {
        expect(Buffer.from((await response.read(3)) ?? []).toString()).toBe("012");
        expect(Buffer.from((await response.read(2)) ?? []).toString()).toBe("34");
        expect(Buffer.from((await response.read(100)) ?? []).toString()).toBe("56789");
        expect(await response.read(100)).toBeUndefined();
        expect(response.headers).not.toHaveProperty("set-cookie");
      } finally {
        response.close();
      }
      const redirect = await sourceHttpTransport({
        url: new URL("http://ignored.invalid/redirect"),
        grant,
        method: "GET",
        headers: {},
        signal: new AbortController().signal
      });
      expect(redirect.status).toBe(302);
      redirect.close();
      expect(hosts).toEqual([`${grant.host}:${grant.port}`, `${grant.host}:${grant.port}`]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
