import { createDocumentWorker } from "./index";

const worker = await createDocumentWorker({
  configPath: process.env.CLIENT_CONFIG_PATH
});

const shutdown = async () => {
  await worker.close();
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

await worker.listen();
