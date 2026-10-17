import {
  assert,
  readDeploymentFile,
  assertWorkerIsolation,
  resolveCompose
} from "./compose-helpers.mjs";

const forbiddenSecrets = [
  "BETTER_AUTH_SECRET",
  "CHAT_SESSION_TOKEN_SECRET",
  "CHAT_SERVER_CREDENTIAL",
  "SERVICE_ACCESS_TOKEN_SECRET"
];
const client = await readDeploymentFile("src/client.ts");
if (/knowledgeWorker:\s*["']separate["']/u.test(client)) {
  for (const file of ["docker-compose.yml", "docker-compose.prod.yml"]) {
    const compose = await resolveCompose(file, [...forbiddenSecrets, "DOCUMENT_WORKER_TOKEN"]);
    const worker = compose.services["knowledge-worker"];
    assert(worker, `${file}: knowledge-worker service is required for knowledgeWorker: separate`);
    assertWorkerIsolation(file, compose, "knowledge-worker", { secretNames: forbiddenSecrets });
    assert(
      worker.command?.some((part) =>
        /(?:src\/knowledge-worker\.ts|dist\/knowledge-worker\.js)$/u.test(part)
      ),
      `${file}: knowledge-worker must run its worker entrypoint`
    );
    assert(
      Number(worker.cpus) > 0 && Number(worker.mem_limit) > 0,
      `${file}: knowledge-worker needs a CPU and memory limit`
    );
    assert(
      worker.depends_on?.migrate?.condition === "service_completed_successfully",
      `${file}: knowledge-worker must wait for migrate`
    );
    assert(worker.stop_grace_period === "30s", `${file}: knowledge-worker needs a 30s stop grace`);
    assert(worker.ports === undefined, `${file}: knowledge-worker must publish no ports`);
    assert(
      worker.environment?.KNOWLEDGE_WORKER_ID,
      `${file}: knowledge-worker needs KNOWLEDGE_WORKER_ID`
    );
    const chat = compose.services["doc-worker"];
    if (chat) {
      assert(
        worker.environment?.DOCUMENT_WORKER_URL && worker.environment?.DOCUMENT_WORKER_TOKEN,
        `${file}: knowledge-worker needs document transport credentials for its execution assembly`
      );
      const extraction = compose.services["doc-worker-knowledge"];
      assert(extraction, `${file}: doc-worker-knowledge service is required`);
      assert(
        chat.environment?.DOCUMENT_WORKER_ROLE === "chat",
        `${file}: doc-worker must serve chat only`
      );
      assert(
        extraction.environment?.DOCUMENT_WORKER_ROLE === "knowledge",
        `${file}: doc-worker-knowledge must serve knowledge only`
      );
      assert(
        Number(extraction.cpus) > 0 && Number(extraction.mem_limit) > 0,
        `${file}: doc-worker-knowledge needs a CPU and memory limit`
      );
      assert(extraction.ports === undefined, `${file}: doc-worker-knowledge must publish no ports`);
      assertWorkerIsolation(file, compose, "doc-worker-knowledge", {
        secretNames: [...forbiddenSecrets, "DOCUMENT_WORKER_TOKEN"]
      });
    }
  }
}
console.log("knowledge worker Compose wiring is valid");
