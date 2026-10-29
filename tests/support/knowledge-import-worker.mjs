// The knowledge worker of the import probe (tests/probes/knowledge-import.probe.ts), run as a
// process of its own: the handlers a knowledge worker serves over a fixture source and a stub
// embedding provider, with the platform pool of a production worker (six connections). It runs
// the built packages; native Node has no Vitest aliases, so the parent starts it with
// --experimental-import-meta-resolve. It says what each job kind cost, per stage, when asked.
//
// Parameters come as environment variables: PROBE_DATABASE_URL, PROBE_FILES_ROOT, PROBE_ITEMS,
// PROBE_DIMENSIONS, PROBE_WORKER_ID, PROBE_POOL_SIZE (default 10, the instance default), PROBE_STORE_POOL (default 10, the most a store allows), PROBE_ITEM_BYTES.
import { performance } from "node:perf_hooks";

const packageContext = new URL("../../packages/client-assembly/dist/index.js", import.meta.url)
  .href;
const load = (name) => import(import.meta.resolve(name, packageContext));
const { createDataStores, createKnowledgeBases } = await load("@work-shape/catalyst-data-stores");
const { createFixtureDocumentSource, loadSecretKeyring } = await load(
  "@work-shape/catalyst-connections"
);
const { createPostgresStores } = await load("@work-shape/catalyst-postgres-store");
const { createJobWorker } = await load("@work-shape/catalyst-client-assembly");
const { createFilesystemObjectStorage } = await load("@work-shape/catalyst-object-storage");
const { asClientInstanceId, StoreBackedAuditRecorder, KNOWLEDGE_TEXT_FORMATS } = await load(
  "@work-shape/catalyst-core"
);

const items = Number(process.env.PROBE_ITEMS);
const dimensions = Number(process.env.PROBE_DIMENSIONS ?? 1536);
const poolSize = Number(process.env.PROBE_POOL_SIZE ?? 10);
const itemBytes = Number(process.env.PROBE_ITEM_BYTES ?? 5000);
const clientInstanceId = asClientInstanceId(process.env.PROBE_CLIENT_INSTANCE ?? "demo-local");
const logger = {
  debug() {},
  info() {},
  warn: (...data) => console.error("warn", JSON.stringify(data[0])),
  error: (...data) => console.error("error", JSON.stringify(data[0]), data[1] ?? ""),
  child() {
    return this;
  }
};

// What each stage cost: job kinds as the executor runs them, and the calls a job makes outward.
const stages = new Map();
const note = (stage, ms) => {
  const entry = stages.get(stage) ?? { count: 0, totalMs: 0, maxMs: 0, firstAt: 0, lastAt: 0 };
  const now = performance.now();
  entry.count += 1;
  entry.totalMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  entry.firstAt ||= now - ms;
  entry.lastAt = now;
  stages.set(stage, entry);
};
const timed = async (stage, work) => {
  const started = performance.now();
  try {
    return await work();
  } finally {
    note(stage, performance.now() - started);
  }
};
const profile = () =>
  Object.fromEntries(
    [...stages].map(([stage, entry]) => [
      stage,
      {
        count: entry.count,
        totalMs: Math.round(entry.totalMs),
        meanMs: Math.round((entry.totalMs / entry.count) * 10) / 10,
        maxMs: Math.round(entry.maxMs),
        wallMs: Math.round(entry.lastAt - entry.firstAt)
      }
    ])
  );

const stores = await createPostgresStores({
  databaseUrl: process.env.PROBE_DATABASE_URL,
  poolSize,
  logger
});
const dataStores = createDataStores({
  defaultLocale: "en",
  clientInstanceId,
  stores,
  databaseUrl: process.env.PROBE_DATABASE_URL,
  keyring: await loadSecretKeyring({
    keys: [{ id: "test", ref: "test" }],
    secrets: { resolve: async () => Buffer.alloc(32, 1).toString("base64") }
  }),
  limits: {
    sizeLimitBytes: 1024 ** 4,
    poolMaxConnections: Number(process.env.PROBE_STORE_POOL ?? 10)
  },
  logger
});

// Documents of about `itemBytes`, each its own text: no two share a hash, so every one is
// extracted, chunked and embedded. About 180 words per kilobyte of German-like prose.
const WORDS = [
  "Heizung",
  "Gebäude",
  "Mietvertrag",
  "Nebenkosten",
  "Wartung",
  "Fenster",
  "Eigentümer",
  "Protokoll",
  "Versicherung",
  "Rechnung",
  "Dach",
  "Aufzug",
  "Sanierung",
  "Energieausweis",
  "Hausverwaltung",
  "Kaution",
  "Stellplatz",
  "Abrechnung",
  "Begehung",
  "Gutachten"
];
function textOf(index) {
  let seed = index * 2654435761 + 1;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const paragraphs = [];
  let size = 0;
  while (size < itemBytes) {
    const words = [];
    for (let word = 0; word < 60; word++) words.push(WORDS[next() % WORDS.length]);
    words.push(`Nr. ${index}-${next() % 100000}.`);
    const paragraph = words.join(" ");
    paragraphs.push(paragraph);
    size += paragraph.length + 2;
  }
  return `Dokument ${index}\n\n${paragraphs.join("\n\n")}\n`;
}

const fixture = createFixtureDocumentSource({ secret: "test", pageSize: 1000 });
const encoder = new TextEncoder();
for (let index = 0; index < items; index++)
  fixture.world.put({
    folderId: "folder",
    name: `${index}.txt`,
    mime: "text/plain",
    bytes: encoder.encode(textOf(index))
  });
const capability = {
  ...fixture.capability,
  list: (input, context) =>
    timed("source.list", async () => fixture.capability.list(input, context)),
  async *fetch(input, context) {
    const started = performance.now();
    try {
      yield* fixture.capability.fetch(input, context);
    } finally {
      note("source.fetch", performance.now() - started);
    }
  }
};

// The stub embedding provider: a vector of the model's length at once, no network.
const embedding = {
  defaultBinding: "embedding",
  processingPrices: [{ bindingId: "embedding", currency: "USD", perMillionTokens: 0 }],
  models: [{ bindingId: "embedding", model: "stub", dimensions }]
};
let embedded = 0;
const embed = ({ texts }) =>
  timed("embed", async () => {
    embedded += texts.length;
    return {
      vectors: texts.map((text) => {
        const vector = new Array(dimensions);
        const base = text.length % 97;
        for (let at = 0; at < dimensions; at++) vector[at] = ((base + at) % 31) / 31 + 0.01;
        return vector;
      })
    };
  });

const files = {
  objects: createFilesystemObjectStorage(process.env.PROBE_FILES_ROOT),
  open: async () => undefined
};
const knowledge = createKnowledgeBases({
  defaultLocale: "en",
  clientInstanceId,
  stores,
  backend: dataStores.knowledgeBackend,
  sources: dataStores.knowledgeSources,
  embedding,
  documentFormats: KNOWLEDGE_TEXT_FORMATS,
  maxDocuments: 10_000_000,
  // The stub provider has no quota: the probe indexes as wide as a deployment with a large one.
  indexConcurrency: { perWorker: 32, total: 64 },
  logger
});
const fileJobs = knowledge.fileJobs(
  files,
  new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
  embed
);
const target = {
  protocol: "https",
  host: "fixture.invalid",
  port: 443,
  address: "192.0.2.1",
  family: 4,
  network: "public"
};
const sourceJobs = dataStores.knowledgeSourceJobs({
  files,
  documentFormats: KNOWLEDGE_TEXT_FORMATS,
  maxDocuments: 10_000_000,
  // The probe measures the import, not the confirmation of a large first pass (KB-ISO-1b).
  firstPassStop: Number.MAX_SAFE_INTEGER,
  openSource: async (_name, signal) => ({
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
  })
});

// Time the whole attempt of every job, so a stage's cost is what the executor holds a slot for.
const profiled = (handler) => ({
  ...handler,
  bind(job) {
    const bound = handler.bind(job);
    return {
      ...bound,
      run: (control) => timed(handler.kind.kind, () => bound.run(control))
    };
  }
});

const worker = createJobWorker({
  clientInstanceId,
  stores,
  workerId: process.env.PROBE_WORKER_ID ?? "import-probe-worker",
  logger,
  handlers: [...sourceJobs, ...fileJobs.handlers].map(profiled)
});

process.on("message", async (message) => {
  if (message === "profile")
    process.send({ type: "profile", stages: profile(), embedded, memory: process.memoryUsage() });
  else if (message === "stop") {
    await worker.stop();
    process.exit(0);
  }
});
worker.start();
process.send({ type: "ready" });
