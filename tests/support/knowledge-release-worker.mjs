// Killed after the terminal owned-store commit, immediately before deleting the original.
const packageContext = new URL("../../packages/client-assembly/dist/index.js", import.meta.url)
  .href;
const load = (name) => import(import.meta.resolve(name, packageContext));
const { createDataStores, createKnowledgeBases } = await load("@work-shape/catalyst-data-stores");
const { loadSecretKeyring } = await load("@work-shape/catalyst-connections");
const { createPostgresStores } = await load("@work-shape/catalyst-postgres-store");
const { createJobWorker } = await load("@work-shape/catalyst-client-assembly");
const { createFilesystemObjectStorage } = await load("@work-shape/catalyst-object-storage");
const { asClientInstanceId, StoreBackedAuditRecorder } = await load("@work-shape/catalyst-core");
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  }
};
const clientInstanceId = asClientInstanceId("demo-local");
const stores = await createPostgresStores({
  databaseUrl: process.env.KB13A_DATABASE_URL,
  poolSize: 1,
  logger
});
const dataStores = createDataStores({
  clientInstanceId,
  stores,
  databaseUrl: process.env.KB13A_DATABASE_URL,
  keyring: await loadSecretKeyring({
    keys: [{ id: "test", ref: "test" }],
    secrets: { resolve: async () => Buffer.alloc(32, 1).toString("base64") }
  }),
  limits: { sizeLimitBytes: 1024 ** 3, poolMaxConnections: 3 },
  logger
});
const objects = createFilesystemObjectStorage(process.env.KB13A_FILES_ROOT);
const originalDelete = objects.delete.bind(objects);
objects.delete = async (key) => {
  if (!key.includes("/extracted/")) {
    process.send?.("before_delete");
    await new Promise(() => {});
  }
  return originalDelete(key);
};
const knowledge = createKnowledgeBases({
  clientInstanceId,
  stores,
  backend: dataStores.knowledgeBackend,
  embedding: {
    defaultBinding: "embedding",
    models: [{ bindingId: "embedding", model: "test", dimensions: 8 }]
  },
  documentFormats: ["txt", "markdown"],
  maxDocuments: 10000,
  logger
});
const jobs = knowledge.fileJobs(
  { objects, open: async () => undefined },
  new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
  async ({ texts }) => ({ vectors: texts.map(() => Array(8).fill(0.25)) })
);
const worker = createJobWorker({ clientInstanceId, stores, logger, handlers: jobs.handlers });
worker.start();
