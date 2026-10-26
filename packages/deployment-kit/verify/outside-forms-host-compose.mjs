import {
  assert,
  assertWorkerIsolation,
  modelSecretNames,
  resolveCompose
} from "./compose-helpers.mjs";

// The public host of the outside forms (capability outside-forms, EW-9) is the instance's one
// service on the internet. It connects with a database role of its own, held by row-level
// security to the capability's records, and receives nothing else of the instance: not the
// platform's DATABASE_URL, no signing secret, no model or storage key. A deployment without
// the host passes.

const file = "docker-compose.prod.yml";
const HOST_ENTRY = /outside-forms\/dist\/host\/main\.js$/u;
const HOST_URLS = ["OUTSIDE_FORMS_DATABASE_URL", "OUTSIDE_FORMS_DATABASE_URL_FILE"];
const forbiddenSecrets = [
  "BETTER_AUTH_SECRET",
  "CHAT_SESSION_TOKEN_SECRET",
  "CHAT_SERVER_CREDENTIAL",
  "SERVICE_ACCESS_TOKEN_SECRET",
  "DOCUMENT_WORKER_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  // The superuser of the Compose stack's Postgres, from which an address can be put together.
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  ...(await modelSecretNames())
];
// A value that reads the platform's address, resolved as the helpers resolve a variable.
const readsPlatformUrl = /\/variable-without-default\/DATABASE_URL(?![A-Za-z0-9_])/u;

const compose = await resolveCompose(file, ["DATABASE_URL", ...HOST_URLS]);
const hosts = Object.entries(compose.services).filter(
  ([, service]) =>
    [...(service.entrypoint ?? []), ...(service.command ?? [])].some((part) =>
      HOST_ENTRY.test(part)
    ) || HOST_URLS.some((name) => service.environment?.[name] !== undefined)
);
for (const [name, service] of hosts) {
  const environment = service.environment ?? {};
  assert(
    HOST_URLS.some((url) => environment[url] !== undefined),
    `${file}: ${name} needs OUTSIDE_FORMS_DATABASE_URL, the address with the host's own database role`
  );
  assert(
    environment.DATABASE_URL === undefined,
    `${file}: ${name} must not receive DATABASE_URL, the platform's database role`
  );
  for (const [variable, value] of Object.entries(environment)) {
    assert(
      !readsPlatformUrl.test(String(value)),
      `${file}: ${name} must not set ${variable} from DATABASE_URL: the host connects with its own role (operator runbook: the outside forms host's database role)`
    );
  }
  assertWorkerIsolation(file, compose, name, { secretNames: forbiddenSecrets });
}
console.log(
  hosts.length === 0
    ? "no outside forms host in the Compose stack"
    : "outside forms host Compose wiring is valid"
);
