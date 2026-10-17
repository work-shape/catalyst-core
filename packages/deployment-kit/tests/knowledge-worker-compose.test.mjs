import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const verify = new URL("../verify/knowledge-worker-compose.mjs", import.meta.url);
// Only the worker contract: unrelated UI watches need a newer Compose than the test runner.
const compose = `services:
  migrate:
    image: fixture:local
  knowledge-worker:
    image: fixture:local
    command: [node, clients/demo/dist/knowledge-worker.js]
    stop_grace_period: 30s
    cpus: 2
    mem_limit: 2g
    depends_on:
      migrate:
        condition: service_completed_successfully
    environment:
      KNOWLEDGE_WORKER_ID: fixture-knowledge
      DOCUMENT_WORKER_URL: http://doc-worker:4110
      DOCUMENT_WORKER_TOKEN: fixture-token
  doc-worker:
    image: fixture:local
    environment:
      DOCUMENT_WORKER_ROLE: chat
  doc-worker-knowledge:
    image: fixture:local
    cpus: 2
    mem_limit: 3g
    environment:
      DOCUMENT_WORKER_ROLE: knowledge
`;

test("the operated knowledge worker gate refuses a missing service, a missing limit and leaked auth", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-compose-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/client.ts"),
      'defineClientInstance({ knowledgeWorker: "separate" });'
    );
    const local = compose;
    writeFileSync(join(root, "docker-compose.prod.yml"), compose);
    const run = (source) => {
      writeFileSync(join(root, "docker-compose.yml"), source);
      return spawnSync("env", [`DEPLOYMENT_ROOT=${root}`, process.execPath, verify.pathname], {
        encoding: "utf8"
      });
    };
    const valid = run(local);
    assert.equal(valid.status, 0, valid.stderr);
    const missing = run(local.replace(/^  knowledge-worker:\n[\s\S]*?(?=^  doc-worker:)/mu, ""));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /knowledge-worker service is required/u);
    const noLimit = run(local.replace(/^    cpus:.*\n/mu, ""));
    assert.notEqual(noLimit.status, 0);
    assert.match(noLimit.stderr, /needs a CPU and memory limit/u);
    const leaked = run(
      local.replace(
        "      KNOWLEDGE_WORKER_ID:",
        "      CHAT_SESSION_TOKEN_SECRET: leaked\n      KNOWLEDGE_WORKER_ID:"
      )
    );
    assert.notEqual(leaked.status, 0);
    assert.match(leaked.stderr, /must not receive CHAT_SESSION_TOKEN_SECRET/u);
    const missingTransport = run(local.replace(/^      DOCUMENT_WORKER_URL:.*\n/mu, ""));
    assert.notEqual(missingTransport.status, 0);
    assert.match(missingTransport.stderr, /needs document transport credentials/u);
    const wrongRole = run(
      local.replace("DOCUMENT_WORKER_ROLE: knowledge", "DOCUMENT_WORKER_ROLE: all")
    );
    assert.notEqual(wrongRole.status, 0);
    assert.match(wrongRole.stderr, /doc-worker-knowledge must serve knowledge only/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
