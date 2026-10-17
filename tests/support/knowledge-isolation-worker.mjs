// Runs the production assembly in a second process; the only fixture seam can hold its pool.
const context = new URL("../../packages/client-assembly/dist/index.js", import.meta.url).href;
const { createClientInstanceKnowledgeWorker } = await import(
  import.meta.resolve("@work-shape/catalyst-client-assembly", context)
);
let release;
let transactions;
let service;
const held = new Promise((resolve) => {
  release = resolve;
});
const capability = {
  name: "isolation-fixture",
  create(input) {
    transactions = input.transaction;
    return {};
  }
};
process.on("message", async (message) => {
  try {
    if (message.type === "start") {
      service = await createClientInstanceKnowledgeWorker({
        ...message.input,
        tools: [],
        capabilities: [capability],
        knowledgeWorker: "separate"
      });
      // The parent saturates the pool before starting the loop, with real due index work.
      process.send("ready");
    } else if (message.type === "saturate") {
      let occupied = 0;
      await Promise.all(
        Array.from({ length: message.slots }, () =>
          transactions(async () => {
            if (++occupied === message.slots) process.send("saturated");
            await held;
          })
        )
      );
      process.send("released");
    } else if (message.type === "run") {
      void service.runUntilStopped();
      process.send("running");
    } else if (message.type === "release") {
      release();
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
process.on("SIGTERM", async () => {
  release();
  await service?.stop();
  await service?.close();
  process.disconnect();
});
