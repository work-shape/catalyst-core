// A disposable source worker, killed by the parent after a committed part of a batch.
import { createDataStores } from "@work-shape/catalyst-data-stores";
import { createFixtureDocumentSource, loadSecretKeyring } from "@work-shape/catalyst-connections";
import { createPostgresStores } from "@work-shape/catalyst-postgres-store";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { asClientInstanceId } from "@work-shape/catalyst-core";
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
  databaseUrl: process.env.SRC1A_DATABASE_URL,
  poolSize: 3,
  logger
});
const dataStores = createDataStores({
  clientInstanceId,
  stores,
  databaseUrl: process.env.SRC1A_DATABASE_URL,
  keyring: await loadSecretKeyring({
    keys: [{ id: "test", ref: "test" }],
    secrets: { resolve: async () => Buffer.alloc(32, 1).toString("base64") }
  }),
  limits: { sizeLimitBytes: 1024 ** 3, poolMaxConnections: 3 },
  logger
});
const fixture = createFixtureDocumentSource({ secret: "test", pageSize: 100 });
for (let i = 0; i < 300; i++)
  fixture.world.put({
    folderId: "folder",
    name: `${i}.txt`,
    mime: "text/plain",
    bytes: new TextEncoder().encode("Resumed content")
  });
let fetched = 0;
const capability = {
  ...fixture.capability,
  async *fetch(input, context) {
    if (++fetched === 120) {
      process.send?.("interrupt");
      await new Promise(() => {});
    }
    yield* fixture.capability.fetch(input, context);
  }
};
const worker = createJobWorker({
  clientInstanceId,
  stores,
  logger,
  handlers: dataStores.knowledgeSourceJobs({
    files: {
      objects: createFilesystemObjectStorage(process.env.SRC1A_FILES_ROOT),
      open: async () => undefined
    },
    documentFormats: ["txt", "markdown"],
    maxDocuments: 10000,
    openSource: async (_name, signal) => {
      const target = {
        protocol: "https",
        host: "fixture.invalid",
        port: 443,
        address: "192.0.2.1",
        family: 4,
        network: "public"
      };
      return {
        capability,
        context: {
          connection: {
            id: "fixture",
            name: "fixture",
            revision: 1,
            settings: {},
            authScheme: "bearer",
            operations: []
          },
          target,
          checkEgress: async () => target,
          credentialFor: () => ({ scheme: "bearer", secret: "test", headers: {} }),
          signal
        }
      };
    }
  })
});
worker.start();
