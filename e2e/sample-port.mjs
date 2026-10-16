import { createServer } from "node:net";

/**
 * Find a free port among the exact loopback ports the runner allowed through egress.
 * @param {readonly number[]} ports
 * @returns {Promise<number>}
 */
export async function availableSamplePort(ports) {
  for (const port of ports) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No sample port.");
      return address.port;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  throw new Error(`All sample MCP ports are occupied: ${ports.join(", ")}`);
}
