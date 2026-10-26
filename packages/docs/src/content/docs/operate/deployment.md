---
title: Deployment
description: Package and run a dedicated client instance.
---

Workshape Catalyst runtime services are packaged as Docker images. Docker Compose is the default local and first production-friendly deployment target.

## First Production Shape

```text
reverse proxy / TLS
  -> chat API service
  -> standalone or embedded chat frontend assets
  -> optional tool worker service
  -> Postgres
  -> object storage or backup target
  -> logs, metrics, backups, and deploy scripts
```

Caddy is the default reverse proxy/TLS choice for the first VPS or VM deployment because it keeps automatic HTTPS and routing simple.

The API limits how often one caller may call an operation, and counts a caller who is not
signed in by client address. It reads that address from `X-Forwarded-For` only when the request
comes from a loopback or private address, which is the reverse proxy on the Compose network.
Caddy as the outermost proxy passes the real client address without configuration.

Where another proxy or load balancer stands in front of Caddy (Traefik, a cloud load
balancer), Caddy must be told to trust it. Without this Caddy reports the outer proxy as the
client, and everyone who signs in shares one count:

```caddyfile
{
	servers {
		trusted_proxies static private_ranges
	}
}
```

Name the outer proxy's addresses instead of `private_ranges` where they are known. After the
change, sign in from two networks and check that the API's request log shows two different
`remoteAddress` values.

The counters live in the API process, so an instance runs exactly one API process. The numbers
are set in the release config, see [Rate limits](/configure/release-config/#rate-limits).

## Agent Runs

An Agent Run is a row and a job of the kind `agent_run.execute`. The API writes both in the
transaction that accepts the message and never executes a run itself. A job worker claims the
job, the job claims the run, and every event and message of the run is stored under the lease
of that job.

Where the worker runs is set in the client assembly with `agentRunWorker`:

- `"in_process"` (default): the API process serves the runs with a second job worker. Closing
  the API process ends its runs as interrupted at once.
- `"separate"`: only the processes started with `runAgentRunWorker` serve the runs. On SIGTERM
  such a process takes no new run and gives its runs `AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS` to
  end, 15 minutes unless set. A second signal ends the drain. In Compose, set the worker's
  `stop_grace_period` to at least the drain timeout plus 30 seconds; with less, Docker kills
  the worker mid-drain and its runs fail as lost after the lease time.

One process executes `AGENT_RUN_WORKER_CONCURRENCY` runs at once, 8 unless set. The runs of an
instance that execute at once are that number times its worker processes; further runs wait
queued in the order they were accepted. Keep the default of 8 unless measured otherwise: a
worker process with 8 runs in progress was measured at 201 MB. A run is never executed twice:

- The worker of a run was killed: after the lease time of 90 seconds the next pass of any job
  worker of the instance, the API's included, fails the run with `AGENT_RUN_WORKER_LOST`, the
  reply is shown as interrupted and the conversation takes the next message. Until then the
  reply stands still. No worker has to come back for this.
- The worker was stopped and the run did not end within the drain time: the run fails with
  `AGENT_RUN_RUNTIME_INTERRUPTED`.
- A run stored no event for 30 minutes: it fails as interrupted.
- No Agent Run worker takes a run within 10 minutes of its acceptance: the run fails with
  `AGENT_RUN_NOT_STARTED`, the person is told that the reply could not be started, and the
  conversation takes the next message. The same happens when the backlog is longer than the
  workers take in that time, so add slots or processes before the wait of a healthy instance
  comes near it. Instance > Jobs marks `agent_run.execute` with "No worker takes these" when
  its jobs have been due for a minute and none is running.

A stop request reaches the worker within about a second. The answer of a run and the end of the
run are stored together, so a worker killed at the end of a run leaves no answer beside a
failed run.

Rolling back to the previous release in the single-process topology leaves the runs that were
in flight `running` for up to 30 minutes, with their conversations answering 409, until that
release's own recovery fails them.

## Page Builds

With the module `apps` on, the tool `workspace.open` stores a folder of a conversation's Execution Workspace as a revision of the conversation's preview. The build is the job kind `page.bundle`, and the workspace command worker serves it:

- The worker reads the files by the index the save recorded, checks size and checksum of each, and writes a copy into a temporary directory of its own under `WORKSPACE_COMMAND_TEMP_ROOT`. The directory is removed when the build ends.
- The build is the fixed command `catalyst-page-build` of the runner image, run in the sandbox like a workspace command: no network, read-only root file system, no capabilities, and the CPU, memory and process limits of `infrastructure.sandbox`. Only that directory is mounted. The command gets no environment variable of the worker.
- The worker treats what the command left behind as untrusted data. It reads regular files only, follows no link, refuses a path that leaves the directory or has a `__catalyst` segment, and stops at the file and byte limits instead of reading past them.
- No file of a Page is parsed or run in the API process or in a worker process.

An instance with `modules.apps.enabled: true` needs:

- `executionWorkspaces.enabled: true` and, outside development, `infrastructure.sandbox.provider: docker`. The instance does not start otherwise and names the setting.
- A running workspace command worker. It needs `infrastructure.objectStorage.files` and its credentials in addition to the workspace store. A worker that does not serve `page.bundle` does not start.
- A runner image of the same release. Both runner images carry the command: the platform's `workspace-command-runner` target and the runner image of the capabilities repository. Each runs `catalyst-page-build --check` when it is built, which builds a small Page, so an image without a working command does not come out of its build. An older image has no `catalyst-page-build`; every save then fails with a message that says the runner image must be rolled out. The Infrastructure page does not show this.

The same worker keeps the repositories of assets whose files are one, with two more job kinds:

- `asset_repo.commit` makes the commit of a save. The worker reads the bundles the ledger names from the `files` store, each to no more than the size the ledger recorded, and hands the command only a bundle whose SHA-256 is the recorded one; any other ends the save with `bundle_hash_mismatch`. The commit is the fixed command `catalyst-asset-repo` of the runner image, which runs git in the sandbox under the same limits as a build. The worker believes the result only when the bundle the command left has the size and the hash the result names. It names the bundle on the save's row before it puts the object.
- `asset_repo.sweep` runs every hour. It gives up the saves that did not finish within a day and removes their objects. The object store is never listed: an object is found by its row.

A commit keeps everything it works on below one directory on the disk of the worker, which is the only directory its container mounts: the files, the bundles of the repository, the command's repository and the new bundle. Nothing of it is in the `/tmp` of the sandbox, so a commit takes none of the container's memory for its files; the memory limit of the sandbox (4 GiB unless the instance sets another) holds git and the command, which read one file of at most 2 MiB at a time. One commit takes at most 550 MiB of disk (`ASSET_REPO_COMMIT_DISK_BYTES`: five times the 50 MiB a tree may have and three times the 100 MiB a history may have), two run at a time, and the directory is removed when the commit ended. The worker starts no commit on a disk with less room and refuses the save with `no_space`, as it does when the disk fills on the way; an operator frees space on the worker. A save reads every bundle of the repository. Together they may have 100 MiB (`ASSET_REPO_MAX_BUNDLE_BYTES`); a save that would leave more is refused with `history_too_large`.

Git is in the runner image alone. An older runner image has no `catalyst-asset-repo`; a save then fails with a message that says the runner image must be rolled out. On a `local` sandbox the command runs the git of the machine, which has to be 2.47 or later.

Neither a save nor a command waits for a worker that is not there. Every job worker reports every 10 seconds which kinds of job it claims. A `workspace.exec` call whose command has been due for 30 seconds while the workers of its kind reported nothing for 30 seconds fails: the agent reads that code execution is unavailable and tells the person, and the run goes on. A command behind a worker that reports waits. Instance > Infrastructure shows the sandbox as failed with the time of the last report once the workers were silent for 30 seconds, and `codeExecution` of `GET /instance/infrastructure` says whether code runs and since when. Both recover when a worker is back.

The same rule holds for a save. When a build has been due for 30 seconds and the workers reported nothing for 30 seconds, the save fails and says that no workspace command worker takes Page builds. A worker that reports is waited for; a save whose wait runs out behind it says that the workers are busy.

A build that is published is published once. The revision and the result of the build are written in one transaction while the worker holds the job; a job that is delivered again after a worker stopped finds the result and stores nothing, and a save that gave up gets no revision.

A worker that is killed can leave a build's directory under `WORKSPACE_COMMAND_TEMP_ROOT` and, with the Docker sandbox, its container. Every worker removes directories named `catalyst-page-build-*` and containers named `catalyst-workspace-command-page-build-*` that are older than 15 minutes when it starts and every 10 minutes while it builds.

| Setting                  | Default | Meaning                                                                         |
| ------------------------ | ------- | ------------------------------------------------------------------------------- |
| `PAGE_BUILD_CONCURRENCY` | 2       | Builds one worker process runs at once. One conversation never has two at once. |
| `PAGE_BUILD_TIMEOUT_MS`  | 60000   | A build that runs longer is stopped, its container removed, and the save fails. |

A build takes at most 500 files, 2 MiB per file and 25 MiB in all, and may leave 500 files of 50 MiB in all, in at most 2,000 files and folders nested 32 deep. Memory, CPU and process count are those of the sandbox (4 GiB, 1 CPU and 128 processes by default); there is no disk quota on the build's directory beyond the timeout. A save waits five minutes for its build; when no worker takes it in that time the save fails and a worker that comes later stores nothing.

## Deployment Flow

Separate publishing from deployment:

```text
run checks
  -> build Docker images
  -> tag release
  -> push images
  -> explicitly deploy target client instance
  -> run migrations
  -> restart services
  -> health check
```

Production deploys should be explicit. A GitHub Actions workflow can call the same deploy script that an operator can run manually with the right credentials.

For an instance that Workshape operates, the deployment kit runs this flow. [Operated Instances](/operate/operated-instances/) covers its accounts, Terraform, releases, backups and bucket retention.

## Environment Contract

Do not commit production env files.

Document these values per instance:

- database URL
- model provider credentials
- auth token signing or exchange secrets
- object storage endpoint and credentials
- backup bucket
- public origin
- CORS or embed allowlist
- retention and audit env overrides, if any

For machine API access, configure a `SERVICE_ACCESS_TOKEN_SECRET` of at least 32 characters before starting the API. Treat it as a server signing secret: keep it stable across restarts and identical across replicas. API keys are separate database-backed credentials created in the API Access control plane and supplied only to callers as `CATALYST_API_KEY`; they do not belong in the server deployment environment.

## Database

Postgres is the baseline application store.

Managed Postgres is preferred for production when available. Running Postgres on the same VPS is acceptable for early instances only when backup and restore are treated as product features.

Minimum requirements:

- persistent volume outside the app container lifecycle
- automated external backups
- documented restore procedure
- migration procedure
- monitoring for failed backups
- least-privilege backup credentials

Database schema changes must be shipped as committed Drizzle migration files. Do not use `drizzle-kit push` or any direct schema-push workflow.

Migrations run as an explicit step before the API and the workers start. Each client builds `dist/migrate.js`, and the Compose `migrate` service runs `node <client folder>/dist/migrate.js`. In the operated production Compose files the deploy script runs that service after the pre-deploy backup and before `up`; the services themselves only wait for a healthy Postgres there. In local Compose the API waits for the `migrate` service to complete, and the workers wait for the API. The step holds a Postgres advisory lock on one session, applies each committed migration once, prints the names it applied and names the migration that failed, also when the server ended its connection. While another step holds the lock it waits, and says so on standard error when it starts to wait and every 30 seconds after; it has no deadline.

The API and the workers never migrate. When one starts, it reads the migration state: a database that lacks committed migrations stops it with their names, so a production stack started without the migrate step fails instead of serving an old schema. A database ahead of the release starts, so the previous release keeps serving while a newer one is rolled out. There is no `RUN_MIGRATIONS` switch.

Schema changes expand before they contract. A new migration may hold the additive forms: a new table, type, schema or sequence; a nullable or defaulted column; a column default; a relaxed `NOT NULL`; a constraint added `NOT VALID` and its later validation; inserts and updates; and, in a migration of its own, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Every other statement is a contract step, among them a drop, a rename, a new `NOT NULL`, a column type change, `DELETE`, `TRUNCATE` and a `DO` block: it ships in a later migration under `-- contract-after: <tag>`, once the oldest supported release in `packages/postgres-store/migration-policy.json` has reached that tag. A required column without a default and a blocking index build never pass. `pnpm check:migrations` enforces this for every migration the base branch lacks and rejects any change to a committed migration; `pnpm test:compatibility` runs the database tests of the previous and the oldest supported release against the new schema, and `pnpm test:upgrade` migrates a database of the oldest supported release.

A concurrent index build runs outside a transaction. When it fails, the migration is not recorded and the index stays behind as invalid; repair what stopped it and run the step again, which drops the invalid index and builds it anew.

### Data Stores on the database server

With the module `dataStores` on, each Data Store has a database of its own on this server and two roles, named `catalyst_ds_...`. The platform takes from those roles every way to the platform database and to each other's databases. Three things it leaves to you. Every job of a store looks for them and names them on the store's record, and a name goes once its cause is closed. `GET /api/v1/data-stores/<store>` answers them for one store, each with these steps in a sentence, beside the store's migration level, its size against its limit and how its last migration ended:

- `server_databases_open`: a store role can connect to another database of the server, such as `postgres` or `template1`, where it reads the catalog and nothing else. The platform changes no grant of a database it does not own, because the server may hold more than this instance. On a server that is this instance's alone, run `REVOKE CONNECT ON DATABASE <name> FROM PUBLIC` for each such database as its owner. On a shared server add the line below to `pg_hba.conf`, above the lines that admit the platform, and reload Postgres. Postgres shows that file to no ordinary role, so the condition stays.
- `sessions_open`: the platform's database role is no superuser, so it cannot take the functions that list and end sessions from the roles of a store. A query of a store can then see the sessions of the server and end another query of that store.
- `temp_files_unbounded`: the platform's database role is no superuser, so it cannot set `temp_file_limit` on the roles of a store. A statement of a store that sorts or joins without end fills the disk with temporary files until its timeout.

```text
host postgres,template1 /^catalyst_ds_ all reject
```

A role of a store may change its own password. The platform sets it again before it connects as that role, so keep the Postgres port closed to everyone but the platform: whoever reaches it in between logs in with what the role last set.

A store at its size limit takes no further rows. What a refused insert wrote is given back by a `VACUUM` the platform runs as the owner of the store's database; the autovacuum of the server does the rest.

### The outside forms host's database role

The public host of the outside forms, a process of the paid capability `outside-forms` that the module `outsideForms` serves, is the instance's one service on the internet. It connects to the platform database with a role of its own, never with the platform's. Postgres holds that role to the capability's rows of `capability_records`: row-level security (migration `0154`) keeps every session that logged in as, or switched to, a role whose name starts with `catalyst_outside_forms` to the rows of `outside-forms`, and its grants give it that one table and nothing else, no `DELETE` and no change of the schema. Create the role once on each instance, before the host is switched on.

An instance that already runs the host creates the role and changes its Compose file before it deploys the release with migration `0154`: the deployment kit's policy check of that release refuses a host that still connects with the platform's address. Creating the role first is safe, since the table exists from migration `0152` on and the release's migration step runs before the services start.

1. Connect as a superuser to the platform database. On a Compose host that is the `POSTGRES_USER` of the `postgres` service:

   ```sh
   docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
   ```

2. Create the role, give it a password and the three grants. `\password` asks for the password twice and sends Postgres only its SCRAM hash, so the password lands in no shell history and no server log. Take it from the instance's secret store and keep it there. Where several instances share one Postgres server, give each its own role with the instance in the name, such as `catalyst_outside_forms_acme`: the policy holds every name with the prefix, and each role is granted only its own database. Grant the role no other role, since the host refuses to start as a member of one.

   ```sql
   CREATE ROLE catalyst_outside_forms LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
     NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
   ALTER ROLE catalyst_outside_forms SET statement_timeout = '30s';
   ALTER ROLE catalyst_outside_forms SET lock_timeout = '5s';
   ALTER ROLE catalyst_outside_forms SET idle_in_transaction_session_timeout = '60s';
   ALTER ROLE catalyst_outside_forms SET temp_file_limit = '64MB';
   \password catalyst_outside_forms
   GRANT CONNECT ON DATABASE <platform database> TO catalyst_outside_forms;
   GRANT USAGE ON SCHEMA public TO catalyst_outside_forms;
   GRANT SELECT, INSERT, UPDATE ON TABLE capability_records TO catalyst_outside_forms;
   ```

3. Take from every role of the platform database what Postgres gives all of them and the platform does not use: temporary tables and large objects, both of which fill the disk outside any table's grants. The platform's role owns the database or is a superuser and keeps both. Grant `TEMPORARY` back to any other role of yours that needs it.

   ```sql
   REVOKE TEMPORARY ON DATABASE <platform database> FROM PUBLIC;
   REVOKE EXECUTE ON FUNCTION lo_create(oid), lo_creat(integer), lo_from_bytea(oid, bytea)
     FROM PUBLIC;
   ```

4. Put the address into the instance's env file, with the password URL-encoded, and give it to the host's service and to no other:

   ```sh
   OUTSIDE_FORMS_DATABASE_URL=postgres://catalyst_outside_forms:<password>@postgres:5432/<platform database>
   ```

   ```yaml
   outside-forms:
     environment:
       OUTSIDE_FORMS_DATABASE_URL: ${OUTSIDE_FORMS_DATABASE_URL:?OUTSIDE_FORMS_DATABASE_URL is required}
   ```

   The deployment kit's policy check refuses a host in `docker-compose.prod.yml` that receives `DATABASE_URL`, `POSTGRES_USER` or `POSTGRES_PASSWORD`, or sets its address from `DATABASE_URL`.

5. Start the host. When it opens the records it asks Postgres what its role may reach besides them: superuser, `BYPASSRLS`, ownership of the table, membership of another role, privileges on another table, column, sequence or schema, a function that runs with its owner's rights, a record of another capability. It stops with that list instead of serving, unless its public address is plain `http` on `localhost`, a loopback address or a `.localhost` or `.test` name, which only a developer machine runs: there it logs the list as a warning and starts.

The grants and settings stay through later migrations, and a backup's `globals.sql` carries the role, its settings and its password hash, so a restore brings them back. To change the password, run `\password catalyst_outside_forms` again, change the env file and restart the host.

What the role keeps, as every role of the server does:

- It can connect to every database of the server whose `CONNECT` is granted to `PUBLIC`, such as `postgres` and `template1`, and read the catalog of each, including the platform database's table statistics and policies. Run `REVOKE CONNECT ON DATABASE <name> FROM PUBLIC` for each such database, or add a line such as `host postgres,template1 /^catalyst_outside_forms all reject` to `pg_hba.conf`, above the lines that admit the platform (see Data Stores above).
- It can change its own password, which locks the host out until you set it again, and its own session settings, so the timeouts above guard against a mistake in the host, not against a host taken over.
- A host taken over can hold the platform's work up: it may take advisory locks, among them the one the migration step waits for, and lock `capability_records` against every other session. Neither reads nor changes a row it may not reach. Stop the host and end its sessions with `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'catalyst_outside_forms'`.

## Health And Readiness

Two unversioned addresses answer without a credential.

- `GET /health` says the process is up. It reads nothing.
- `GET /ready` says whether this process can serve, and is the check for rotation: use it for the proxy's upstream check and for the deploy script's wait after `up`. The container healthcheck stays on `/health`: other services wait for a healthy API container, and a healthcheck on `/ready` would keep the proxy from starting during a database outage. `/ready` answers `200 { "status": "ready", "migration": "<newest migration of the release>" }` when the database answers within two seconds and holds every migration the release was built with. Otherwise it answers `503 { "status": "not_ready", "reason": "database_unreachable" }` or `503 { "status": "not_ready", "reason": "database_behind", "missing": ["<migration>", ...] }`. A database ahead of the release is ready, so the previous release stays in rotation while a newer one is rolled out.

`/ready` checks the database and nothing else. A model or mail provider outage does not take the API out of rotation. The answer names migrations only: no host, no account, no connection string and no driver error. The document worker answers `/ready` on its own port with the same body and status.

The proxy has to forward `/ready` to the API like `/health`; it is outside `/api/*`.

## What The Proxy Routes To The API

Everything else goes to the interface. A deployment with its own proxy routes these to the API:

| Address             | What it is                                         |
| ------------------- | -------------------------------------------------- |
| `/api/*`            | The product API.                                   |
| `/auth/*`           | Sign-in of an instance with standalone auth.       |
| `/health`, `/ready` | The two checks above.                              |
| `/app-runtime/*`    | The runtime and the shell of a generated view.     |
| `/app-content/*`    | The files of a Page, when the module `apps` is on. |

`docker/Caddyfile` routes all of them.

An address below `/app-content/` holds a token in its path: `/app-content/<file set>/<token>/<file>`. The token is a bearer capability. The API mints it after it has checked that the person may read the Page, and for one hour (`APP_CONTENT_TOKEN_TTL_SECONDS`) it serves the built files of that one revision to whoever holds the address, as long as that person may still read the Page. The API asks again every 30 seconds per address (`APP_CONTENT_VIEWER_CHECK_SECONDS`): once the account is deactivated or the person no longer reads the conversation, the address answers `404` at most 30 seconds later. It is not bound to the person's session: signing out does not end it before the hour is over.

So no layer may write these addresses down:

- The API writes no request line for them, whichever way the address is spelled.
- `docker/Caddyfile` writes no access log. If you add a `log` directive, leave these addresses out with `log_skip /app-content/*`.
- `docker/nginx-spa.conf` answers `/app-content` with `404` and `access_log off`, for the case that such an address reaches the interface's server.
- Any other proxy, load balancer or CDN in front must be set the same way, and must not cache these answers: they carry `Cache-Control: private` or `no-store`.

A proxy's error log is not its access log: when the API does not answer, Caddy writes the address of the failed request to its error log, so proxy error logs can hold the address of a Page that stays valid for up to the lifetime of its token.

A Page's own script can read the address it was loaded from. The token is therefore a secret from other people and not from the Page.

## Production Readiness Checklist

Before a real deployment:

- release config validates
- migrations run cleanly
- `/health` answers and `/ready` answers `200` on the API and the document worker
- TLS is configured
- production secrets are not in Git or images
- backups run and restore has been tested
- model provider billing alerts or budgets exist
- retention and deletion behavior is documented
- audit views are permissioned
- user access path is tested
- customer-hosted integrations have timeout and failure behavior

## Release Gate For The `/api/v1` Cutover

The release that moves the product API under `/api/v1` answers 404 at every old path, with no alias. Interface, CLI and server ship together, so the only callers it can break are outside ones: a backend that issues chat session tokens for an embedded chat.

Before deploying that release to an operated instance:

1. Search the instance's access log for `POST /auth/session-token` and `POST /api/superadmin/session-tokens` over the log's whole retention.
2. Record the result with the release: the two paths, the period searched, and per path the request count and the calling hosts. Record metadata only, never request bodies, tokens or the server credential.
3. Move every caller found to `POST /api/v1/instance/session-tokens` in the same release. The `x-server-credential` header and the payload are unchanged.
4. Give every CLI runner a `CATALYST_API_KEY`; the CLI no longer signs in with the server credential. The server needs `SERVICE_ACCESS_TOKEN_SECRET` for the key exchange.
5. Tell users to reload open tabs after the upgrade. A tab loaded before it calls the old paths and shows "Operation is not available"; later releases show a notice with a reload action instead.

A reverse proxy that forwards `/api/*` and `/health` needs no change.
