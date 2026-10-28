# Preview capture (SRV-1)

Dark infrastructure for a server screenshot of an App. `preview.capture` still uses the
person's browser. No App call in this service reads or changes anything: all calls are
`not_available`. No grant is minted, and `apps.captures.call` refuses all callers.

Privacy and authorization assumptions: the renderer stays inside the instance and region;
no hosted rendering provider is used. Only a request written by a live person-owned run
can enqueue a capture; the API verifies run, person, conversation, revision and frame rights
again before minting an address. Stub content omits saved App storage. An address lives to
the request deadline plus five seconds and stops serving as soon as its row ends. It is not
an App-session proof. No route or service request accepts a person or chooses a run.

The picture is a managed conversation artifact under its retention; request rows and bounded
diagnostics expire with existing capture pruning after 24 hours. No payload, picture, token,
address or report goes into audit, Operation Runs or service logs. Reports are untrusted page
output. The service has no store, database, auth, session, content or model credentials.

Build with `pnpm --filter @work-shape/catalyst-preview-capture build`. The deployment kit
ships an opt-in Compose overlay, `docker/preview-capture.compose.yml`, and image target
`preview-capture`. No deployment repository is changed in SRV-1. Supply only the service
token (32+ characters), the API and interface origins, and slot count. The API connects only
with `PREVIEW_CAPTURE_ENABLED=true`; it defaults off. The instance assembly supplies the package; a deployment may also start its isolated process
through `defineClientInstance().runPreviewCaptureService()`, which never loads dotenv files.

The renderer runs on non-root Linux with an internal API-only network, a read-only filesystem,
tmpfs profile, 256 MiB shared memory, all capabilities dropped and no privilege escalation.
Use the shipped seccomp profile (Docker default plus Chromium's namespace syscalls plus chroot inside the namespace), never
`unconfined`. Startup probes a real renderer and refuses without Seccomp 2 and a user namespace
different from the browser's; it then closes the probe browser. Chromium starts on demand and
closes after three idle minutes, after 200 captures or after failure. Each capture gets a fresh
context, no downloads or service workers, a 20-second deadline and bounded output. Two slots
(default) fit the 768 MiB service limit. Use one slot and 512 MiB on a small host, recording its
memory budget before enabling. Four requests may wait for at most ten seconds; excess is
`capture_busy`. A failed render is `capture_failed`; there is no automatic retry.

Migration 0168 only adds nullable fields to the existing request table; previous versions keep
using the browser transport. Apply it through the reviewed deployment migration step before
enabling the service. To roll back, turn off the flag and profile; leave the nullable columns
in place while previous API/worker processes drain. The feature remains dark until SRV-2.

Local container proof (no deployment): build asset-schemas and core, pack them with
`pnpm --filter @work-shape/catalyst-asset-schemas pack --out packages/preview-capture/schemas.tgz`
and `pnpm --filter @work-shape/catalyst-core pack --out packages/preview-capture/core.tgz`,
build preview-capture, then `docker build -t catalyst-srv1-preview-capture packages/preview-capture`.
Run `node tests/support/build-capture-fixture.mjs` and
`CAPTURE_BROWSER_TESTS=1 pnpm exec vitest run tests/preview-capture-service.browser.test.ts`.
This starts only test-owned containers on an internal network, removes them afterwards, and
leaves the WebP pictures and sandbox evidence in `.tmp/capture-proof/`.

Blocked requests report only method, host and path, without queries or bearer segments.
When Chromium refuses through CSP before creating an HTTP request, the method is `CSP`:
DevTools supplies the blocked URL, but no HTTP method exists at that point. These diagnostics
come from Node's network and DevTools observers, independently of the Page's guard.
