import net from "node:net";
import tls from "node:tls";
import { z } from "zod";

/**
 * A relay in front of a Postgres server, for what a test must see from outside the executor:
 * how many bytes the server was asked to give up, and a TLS endpoint where the server has none.
 */
export interface PostgresRelay {
  readonly port: number;
  /** Bytes the relay took from the server for its clients. */
  bytesFromServer(): number;
  /** Connections that opened with a request to cancel a backend's query. */
  cancelRequests(): number;
  /** Connections that completed the TLS handshake. */
  securedConnections(): number;
  close(): Promise<void>;
}

/** The SSLRequest message: length 8, code 80877103. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

export async function startPostgresRelay(
  server: { host: string; port: number },
  secure?: { key: string; certificate: string }
): Promise<PostgresRelay> {
  let fromServer = 0;
  let secured = 0;
  let cancels = 0;
  const open = new Set<net.Socket>();

  function join(client: net.Socket): void {
    const upstream = net.connect(server);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client]
    ] as const) {
      open.add(from);
      from.on("error", () => undefined);
      from.on("close", () => {
        open.delete(from);
        to.destroy();
      });
    }
    upstream.on("data", (chunk: Buffer) => {
      fromServer += chunk.length;
    });
    client.once("data", (first: Buffer) => {
      // The CancelRequest message: length 16, code 80877102.
      if (first.length === 16 && first.readUInt32BE(4) === 80877102) cancels += 1;
    });
    client.pipe(upstream);
    upstream.pipe(client);
  }

  const listener = net.createServer((socket) => {
    if (!secure) {
      join(socket);
      return;
    }
    socket.on("error", () => undefined);
    socket.once("data", (first: Buffer) => {
      if (!first.equals(SSL_REQUEST)) {
        socket.destroy();
        return;
      }
      socket.write("S");
      const client = new tls.TLSSocket(socket, {
        isServer: true,
        key: secure.key,
        cert: secure.certificate
      });
      client.once("secure", () => {
        secured += 1;
      });
      join(client);
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(listener.address());

  return {
    port,
    bytesFromServer: () => fromServer,
    cancelRequests: () => cancels,
    securedConnections: () => secured,
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        listener.close(() => resolve());
      })
  };
}
