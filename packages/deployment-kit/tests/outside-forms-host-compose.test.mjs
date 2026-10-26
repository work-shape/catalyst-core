import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const verify = new URL("../verify/outside-forms-host-compose.mjs", import.meta.url);
const compose = `x-app-environment: &app-environment
  DATABASE_URL: \${DATABASE_URL:?DATABASE_URL is required}
  BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET:?required}
services:
  api:
    image: fixture:local
    environment:
      <<: *app-environment
  outside-forms:
    image: fixture:local
    command: [node, deployment.acme/node_modules/@work-shape/catalyst-outside-forms/dist/host/main.js]
    environment:
      OUTSIDE_FORMS_DATABASE_URL: \${OUTSIDE_FORMS_DATABASE_URL:?OUTSIDE_FORMS_DATABASE_URL is required}
      OUTSIDE_FORMS_PUBLIC_URL: https://forms.example.test
      CLIENT_INSTANCE_ID: acme
`;

test("the outside forms host gets its own database address and nothing of the platform", () => {
  const root = mkdtempSync(join(tmpdir(), "outside-forms-compose-"));
  try {
    const run = (source) => {
      writeFileSync(join(root, "docker-compose.prod.yml"), source);
      return spawnSync("env", [`DEPLOYMENT_ROOT=${root}`, process.execPath, verify.pathname], {
        encoding: "utf8"
      });
    };
    const valid = run(compose);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /outside forms host Compose wiring is valid/u);

    const platformRole = run(
      compose.replace(
        "${OUTSIDE_FORMS_DATABASE_URL:?OUTSIDE_FORMS_DATABASE_URL is required}",
        "${DATABASE_URL:?DATABASE_URL is required}"
      )
    );
    assert.notEqual(platformRole.status, 0);
    assert.match(platformRole.stderr, /must not set OUTSIDE_FORMS_DATABASE_URL from DATABASE_URL/u);

    const appEnvironment = run(
      compose.replace(
        "      OUTSIDE_FORMS_PUBLIC_URL:",
        "      <<: *app-environment\n      OUTSIDE_FORMS_PUBLIC_URL:"
      )
    );
    assert.notEqual(appEnvironment.status, 0);
    assert.match(appEnvironment.stderr, /must not receive DATABASE_URL/u);

    const fromParts = run(
      compose.replace(
        "${OUTSIDE_FORMS_DATABASE_URL:?OUTSIDE_FORMS_DATABASE_URL is required}",
        "postgres://${POSTGRES_USER:?x}:${POSTGRES_PASSWORD:?x}@postgres:5432/app"
      )
    );
    assert.notEqual(fromParts.status, 0);
    assert.match(fromParts.stderr, /must not receive POSTGRES_USER/u);

    const byEntrypoint = run(
      compose
        .replace("  outside-forms:", "  forms:")
        .replace("    command: [node,", "    entrypoint: [node,")
        .replace(/^ {6}OUTSIDE_FORMS_DATABASE_URL:.*\n/mu, "")
    );
    assert.notEqual(byEntrypoint.status, 0);
    assert.match(byEntrypoint.stderr, /forms needs OUTSIDE_FORMS_DATABASE_URL/u);

    const missing = run(compose.replace(/^ {6}OUTSIDE_FORMS_DATABASE_URL:.*\n/mu, ""));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /needs OUTSIDE_FORMS_DATABASE_URL/u);

    const none = run(compose.replace(/^ {2}outside-forms:\n[\s\S]*$/mu, ""));
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /no outside forms host/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
