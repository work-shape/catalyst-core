import { createServer } from "node:net";
import { expect, it } from "vitest";
import { availableSamplePort } from "../e2e/sample-port.mjs";

it("skips an orphan's occupied port instead of connecting with a new key to its old server", async () => {
  const orphan = createServer();
  await new Promise<void>((resolve, reject) => {
    orphan.once("error", reject);
    orphan.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = orphan.address();
    if (!address || typeof address === "string") throw new Error("Orphan has no port.");
    await expect(availableSamplePort([address.port])).rejects.toThrow(
      "All sample MCP ports are occupied"
    );
    const next = await availableSamplePort([address.port, 0]);
    expect(next).toBeGreaterThan(0);
    expect(next).not.toBe(address.port);
    expect(orphan.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => orphan.close(() => resolve()));
  }
});
