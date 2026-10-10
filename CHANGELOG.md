# Changelog

All platform packages are released in lockstep under one version. Before 1.0 a minor version may
contain breaking changes; a patch version does not.

## Unreleased

### Added

- **Pages:** a conversation can hold Pages, each with numbered revisions. A revision is a file
  set that is stored once and never changed. The module `apps` owns them and is off by default;
  with it on, startup stops with the missing piece named unless `infrastructure.objectStorage.files`
  is configured and `CHAT_SESSION_TOKEN_SECRET` or `BETTER_AUTH_SECRET` is set with at least 32
  characters. `GET /api/v1/conversations/{conversationId}/pages`, `.../pages/{pageId}` and
  `.../pages/{pageId}/file-sets/{fileSetId}/source-file` read them, and `POST .../pages/{pageId}/preview`
  answers the address a frame loads a revision from. No operation stores a Page yet. A file set
  holds at most 500 files, 2 MiB per file and 25 MiB in all, a Page at most 1,000 revisions, a
  conversation at most 200 Pages. Deleting a conversation, a workspace or a user removes their
  Pages, rows and files, whether the module is on or off.
- **Pages, serving:** the files of a revision are served at
  `/app-content/<file set>/<token>/<file>`. **A reverse proxy must route `/app-content/*` to the
  API**, as it does `/app-runtime/*`, and must not write these addresses to an access log:
  the token is a bearer capability, minted after the check that the person may read the Page
  and valid for one hour for whoever holds the address. `docker/Caddyfile` and
  `docker/nginx-spa.conf` are changed accordingly. An HTML file is never answered as stored: the
  answer is a shell that holds it in a frame with `sandbox="allow-scripts"`, under the header
  `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self'
  'sha256-<the platform's script>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none';
  frame-ancestors 'self' <allowed origins>`. A Page therefore has no origin, sends no form,
  opens no window, reaches no other host and cannot move its frame. The platform's script is the
  only content of the frame's document and writes the stored HTML into it as its last step, so
  there is no Page where that script did not run. In a Page a link has no address, there are no
  frames, `document.write` is refused and the WebRTC constructors are removed by name; this
  part runs in the Page's own realm and is hardening, not a boundary. WebRTC from a scripted
  frame stays a known open exit. Tested in Chromium only.
- **Database:** migration `0050_pages` adds the tables `pages` and `file_sets`.

- **Infrastructure:** the page **Instance > Infrastructure** in the settings and
  `GET /api/v1/instance/infrastructure` list what the instance runs on: every entry of the
  `infrastructure` section and the database, each with its provider, region, endpoint host or
  bucket, its secrets with "set" or "missing", and the result of its last check. Both need
  `users.manage` and change nothing. No secret value, connection string, key or host path is
  returned. A secret is shown by its name while it is set; one that is missing is shown by the
  config key that names it. A host or a bucket that does not read as one is shown as "not shown"
  and named in a warning of the server log by provider and field. Every provider now has a
  check, the cheapest authenticated read it has, which ends after five seconds together with the
  creation of the provider. An S3 store is asked with one `HEAD` of its bucket; a missing bucket
  is the class `bucket_missing` and is not created. The new job kind `infrastructure.check` runs
  the checks of the API every five minutes, the workspace command worker checks the sandbox
  with the kind `infrastructure.check_sandbox`, and
  `POST /api/v1/instance/infrastructure/check` runs the API's checks once more, at most once a
  minute for the instance. A failed check carries a class from a closed list and never the
  provider's own error text. A provider that fails does not change `/ready`.
  `defineProvider` requires `check`: a capability that registers a provider must add one.
- **Database:** migration `0046_infrastructure_check_state` adds the table
  `infrastructure_check_state`, one row per instance with the last check outcome of each
  provider and the time of the last manual check. Every API process reads it, so the page shows
  the same health whichever process answers.
- **Models:** a second model adapter, `google-vertex`, calls Gemini on Vertex AI through
  `generateContent`: text, tools, images, PDF documents, answers in a JSON format, streaming and
  abort. An entry under `infrastructure.models` takes `projectId` and `credentialSecret` (default
  `GOOGLE_VERTEX_CREDENTIALS`, the JSON key of a service account), and its `region` decides the
  endpoint and location: `eu` stays on `aiplatform.eu.rep.googleapis.com`. Web search, reasoning
  efforts, the fast tier, server-side compaction and tool calls are not declared, so a call that
  asks for one is refused before it is sent. Tool calls wait until the adapter carries Gemini's
  thought signatures: a call with tools or with a tool call in its history is refused with
  `VALIDATION_FAILED`, and a binding on such a provider must state `agentSelectable: false`, or
  startup stops with: `Model binding '<id>' can be chosen for agents, but provider '<id>' does
  not support tool calls, which every agent run needs: set 'agentSelectable: false' on the
  binding`. The check on **Instance > Infrastructure** asks Google for a token with the key; it
  does not call Vertex. A model message can carry a PDF document; the
  gateway refuses such a call for a model that does not read documents, and fails a call that
  asked for a JSON format with `invalid_response` when the answer is not JSON, after settling
  what the call used. An answer the provider counted and then blocked or could not form is
  settled with the usage it reported. A conformance suite runs the same recorded cases against
  both adapters.
- **Capability SDK:** the capability context has `models`, the instance's model gateway for a
  capability's own calls. `models.complete` takes a model binding, a purpose, text and PDF
  content and an optional JSON format, and `models.describeBinding` says what the binding's
  model can do. The call is admitted and recorded like every model call. A worker process of a
  capability gets the same from `createWorkerCapabilityModels` of
  `@vivd-catalyst/client-assembly`, which creates only the providers behind the bindings it is
  given.
- **Assets:** agents and skills are read and written at `/api/v1/assets/{kind}/...` through nine
  operations: `assets.list`, `assets.get`, `assets.put`, `assets.delete`, `assets.revisions.list`,
  `assets.revert`, `assets.validate`, `assets.sync` and `platform.context.get`. Each call is one
  Operation Run and is decided by the right on the one asset (`<kind>.read`, `.write`, `.delete`),
  so a holder of rights in a Namespace lists, reads and writes the assets of that Namespace.
  `assets.list` answers summaries in pages, filtered by name prefix and text. A write names the
  revision it was made against in `expectedRevision` and answers `409 CONFLICT` with
  `details.currentRevision` when the asset stands at another one; a put without it creates the
  asset and is refused when the name is taken. `assets.sync` applies up to 200 puts and deletes
  for one Namespace completely or not at all, reports each item and reaches no asset outside the
  prefix. The right on every item is decided before the policy is asked, and a policy setting
  narrowed to a kind or a Namespace applies to every asset call that names one of that kind or in
  that Namespace. A reference to an asset the caller may not read is answered like a reference to
  an asset that does not exist. `platform.context.get` now also answers a service principal and names only the actions
  the credential's scopes allow. **Breaking:** the five old asset addresses are gone. Scripts that
  called them use `/api/v1/assets/...`; the CLI is unaffected. The operations
  `config_assets.get`, `put`, `delete`, `revert` and `revisions.list` under
  `/api/v1/instance/config/assets/{kind}/{name}` answer `404`, and the instance-wide `baseVersion`
  of these writes is replaced by the asset's `expectedRevision`. Three migrations (0047 to 0049)
  tie an asset a workspace owns to that workspace: deleting the workspace deletes its assets and
  the grants on them.
- **Modules:** a module that is off is off everywhere. Each of its operations answers
  `404 NOT_FOUND` with `details.reason: "module_off"` and the module in `details.module`, to a
  caller who is authenticated; a call without a credential gets `401` as on any route. Its agent tools are not offered to the model and cannot be called,
  and a write that adds or changes an agent that names one is refused with a message that names
  the module; an agent stored earlier keeps its entry, runs without the tool and holds up no
  other write, and the agent editor shows the entry as not available and removable. Its job kinds
  are not claimed, and their queued jobs stay queued and say under **Instance > Jobs** which
  module they wait for. The operations of `assetManagement` answered `403 FORBIDDEN`
  while the module was off and answer this `404` now. The page **Instance > Modules** in the
  settings and `GET /api/v1/instance/modules` list every module with its state, what it adds and
  its config key; both need `audit.view` and change nothing, because the switch is release config.
- **Access:** an instance administrator can give one user read, write or delete on agents or
  skills inside a Namespace or on one asset, and can deny it. A Namespace is a registered name
  prefix such as `kai-`; it can carry a list of allowed tools and a list of allowed model
  bindings, which bind every writer of an agent in it, an administrator and the release sync
  included. Eight operations under `/api/v1/instance/access` write and read grants and Namespaces;
  they need `users.manage`. A deny wins over every grant and role that would allow the same action
  on that asset. It does not wall the asset off from holders of instance rights: export and
  setting the default agent are decided at the instance and still reach it. A holder who is denied
  anything on an asset cannot delete it. Deleting an asset removes the allow rows on it and keeps
  the deny rows: a deny on a name stays until it is revoked, also across delete and recreate, and
  the grant list keeps showing it. In a Namespace with a list of model bindings, a user who may
  write agents there sets `modelBindingId` to a binding on the list without holding
  `agent_models.manage`; a binding off the list is refused for everyone, and an agent that names a
  provider or no model is refused unless the writer holds `agent_models.manage`. A grant's
  `grantedBy` and a Namespace's `createdBy` are left out for a caller who is not shown that user.
  Deleting a user deletes the user's grant rows. The page **Instance > Access** in the settings
  writes and shows all of this in three tabs, Namespaces, Grants and Check, and is shown to holders
  of `users.manage`; a grant row of asset scope answers with `scopeAsset`, the kind and name of
  its asset and whether it still exists. `scopeAsset.name` is left out for a caller who may not
  read that kind of asset; the row still carries `scopeId`. A migration adds
  the tables `permission_grants` and `namespaces` and changes no other table; no user, service
  principal or API key gains or loses a right. `node --experimental-strip-types
scripts/verify-permissions.ts` with `DATABASE_URL` set compares every holder's rights with what
  the legacy columns answered and exits non-zero on a difference. Before rolling back to an
  earlier release, list the deny rows (`select * from permission_grants where effect = 'deny'`):
  an earlier release reads neither table, so every grant stops applying and every deny stops
  refusing. An earlier release that deletes an agent or skill leaves the grant rows on it, and
  they apply again if the same name is created after rolling forward. Remove them first: `delete
from permission_grants where scope_kind = 'asset' and effect = 'allow' and scope_id in (select
id from config_assets where status = 'deleted')`.
- **Operations:** an operation can be registered once in the operation registry and is then
  reached through one call path, `runOperation`, that checks the actor's right, resolves the
  policy, asks the guardrails, executes and records the call as an Operation Run. Over HTTP
  the status says how the run went: `200` with the output, `202` with the run and a
  `Location` header while it waits for an approval, `403` for a refusal (`FORBIDDEN`,
  `POLICY_DENIED`, `GUARDRAIL_BLOCKED`, `DECLINED`), the operation's own error for a failure.
  Every answer of such a call names its run in the header `Operation-Run-Id`. A changing
  operation takes an `Idempotency-Key`, scoped to its caller: the same call again is answered
  from the run with `Idempotent-Replayed: true`, and `409` tells a key used for another call
  (`IDEMPOTENCY_KEY_REUSED`), a first call still running (`OPERATION_IN_PROGRESS`), an
  expired one (`OPERATION_EXPIRED`) or an answer too large to keep (`OUTPUT_NOT_RETAINED`).
  A changing call that failed is never run again under its key, since it may have changed
  something before it failed: the key answers the recorded failure again, with the same
  status and code and `Idempotent-Replayed: true`, and another attempt takes a new key. Only
  a call that failed before its operation was reached runs again under its key. A changing
  call that was interrupted answers `409 OPERATION_IN_PROGRESS` with
  `details.interrupted: true`, because nobody knows how far it got. A replay answers the
  actor that holds the key without asking for the right again: the actor had it when the
  call ran, and a refusal would hide an outcome that happened. The origin of a run over HTTP
  follows how the call was authenticated: a browser session is `user`, a key or token in the
  request is `cli`, also for a person's token. An operation that requires no right must be
  registered with an `authorize` function, which is asked where a named right is: after the
  scope and before the policy, the guardrails and an approval. Without one the server does
  not start.
  No operation of the release is registered this way yet. A run stores a hash of the input,
  never the input, and for a failure a code and a safe message.
- **Operations:** `GET /api/v1/operations/runs/{runId}` reads one Operation Run and
  `GET /api/v1/operations/runs` lists them, filtered by operation, status, actor, origin,
  workspace and time. A caller reads its own run; any other run and the list take the right
  to view the audit log. Both take the scope `governance:read`.
- **Release config:** `policy.defaults` sets the policy value of operations that nothing else
  names one for: `reading` is `allow` or `deny` (default `allow`), `changing` is `allow`,
  `confirm`, `approval` or `deny` (default `confirm`). An instance without the section gets
  the defaults.
- **Database:** migration `0033_operation_runs` adds the table `operation_runs` and the
  nullable columns `user_id`, `collaboration_workspace_id` and `operation_run_id` on
  `model_usage_events`. Nothing writes the three columns yet. The previous release runs
  against the migrated database.
- **API client:** a method of an operation that can wait for an approval answers an
  `OperationOutcome`: `done` with the output or `pending_approval` with the run. The client
  sends a new `Idempotency-Key` with every such call unless the caller passes
  `idempotencyKey`. `createApiClientFor(operations, options)` builds the same client for
  operations outside the release's catalog. Cross-origin browsers may send `Idempotency-Key`
  and read `Operation-Run-Id`, `Idempotent-Replayed` and `Location`.
- **API contract:** `defineRegisteredOperation` defines an operation of the registry.
  `defineOperation` takes an optional second success answer (`accepted`) and declared
  `headers`, which the OpenAPI document states. Error codes that share a status share one
  answer in the document, named after all of them.

- **API:** `GET /api/v1/conversations` takes an optional `query`. It keeps the conversations
  whose title contains the text, without regard to case, with the paging and the access
  filter of the list.
- **API reference:** an instance serves the OpenAPI document of the operations it runs at
  `GET /api/v1/openapi.json` and the same document as a page at `GET /api/v1/docs`. Both
  answer any signed-in person and any access token, whatever its scopes, and refuse a caller
  without a credential. The page holds no script and loads nothing from another host. The
  docs site has an "API Reference" section written from the release's document at build time.
- **API contract:** `openapi.json` is an OpenAPI 3.1 document with the release version, named
  schemas, the credentials each operation accepts with the scope it needs, an answer for every
  error code, `text/event-stream` and 204 for a stream, and the effect, rights and rate class
  of each operation as `x-catalyst-*` fields. It ships in `@vivd-catalyst/api-contract` as
  `@vivd-catalyst/api-contract/openapi.json`. `pnpm generate:openapi` writes it;
  `pnpm check:openapi` fails when it is stale or has a lint finding; `pnpm check:contract`
  fails on a change that breaks a caller of the newest release whose document has `/api/v1`
  paths, and passes with a notice while no such release exists. Both run in `pnpm check`.
  The package also exports `findBreakingChanges`, `describeApiReference` and
  `renderApiReferencePage`.

- **Chat:** the composer's model selector is a model picker. It opens as a short menu with the
  model and its reasoning effort; the model list shows each model's provider logo and an EU
  mark for providers with `region: eu`, and a model under the pointer brings up a
  card with its description and usage consumption. A model binding can carry `description`,
  `vendor` and `usageTier` for it. The usage tier comes from the Customer Rate Card unless the
  binding sets one.
- **Chat:** users can pick the reasoning effort of a model: `low`, `medium`, `high`, `xhigh`
  or `max` unless the binding's `userSelectableReasoningEfforts` lists others, and an empty
  list turns the choice off. `max` is a new reasoning effort, also available in agent model
  settings. The agent's configured effort stays the default. The run
  API accepts `reasoningEffort` and rejects an effort the model that runs does not offer. A
  migration adds `agent_runs.reasoning_effort`.
- **Chat:** a model or reasoning effort the user picks becomes their default for new
  conversations, on every device. A conversation that already ran stays on what its latest run
  used, and a user who never picked anything follows the configured defaults. The pick is
  stored per user (`/api/v1/me/model-preference`); a migration adds `product_users.model_preference`.
- **Workspaces:** a superadmin is Owner of every Shared Workspace without being a member. The
  workspace selector lists them under "Other workspaces"; the superadmin can open their
  settings, manage members and access requests, and read and start conversations there.
  Private conversations stay with their author and Personal Workspaces with their user. A
  workspace in the API carries `membershipRole` (`null` without a membership) next to `role`,
  which is what the caller may do.
- **Interface, Settings:** Instance > Jobs shows what the instance works on in the background.
  A table counts the queued, running, failed and dead jobs of each kind, kinds with failures
  first, and names how long the oldest due job has waited. Below it the jobs are listed under
  Failed and dead, Running and Queued, newest first; a kind in the table narrows the list to
  itself. A job shows its kind, status, attempts, when it was created and ended, the class of
  its last error and the id of the record it works on. It never shows the job's payload or an
  error message. The page asks again every ten seconds while its tab is visible. It needs
  `audit.view`.
- **Jobs:** a superadmin can retry a failed or dead job from that page. The job is queued
  again with its attempts reset and, in the same transaction, the record it works on is put
  back into the state the job starts from: a failed preview is pending again, a failed draft
  attachment is queued again. A job is not retried when a newer job already does its work,
  when its record can no longer be worked on, or when its kind is not retried by hand; a
  schedule tick is such a kind, because the next tick is its retry. The audit log records
  `job.retried` with the job and its kind.
- **API:** `GET /api/v1/instance/jobs/summary` and `GET /api/v1/instance/jobs` (filters `kind`
  and `status`, 50 per page) need `audit.view` and the scope `governance:read`.
  `POST /api/v1/instance/jobs/{jobId}/retry` is an operation of the registry that only a
  superadmin may call; it answers `409 CONFLICT` with `details.status`, or with
  `details.reason` `superseded`, `kind_not_retried` or `subject_not_restorable`.
- **Extension API:** a job kind can declare `manualRetry: false`. A capability hands the API
  `jobRetries` in its contribution: one entry per kind whose ended jobs may be retried by
  hand, with an optional `restoreSubject` that runs in the retry's transaction. The API
  retries no job of a kind it was given no entry for. `ChatServerOptions.jobRetries` carries
  them to the server. `PlatformFileStore` gains `restoreFailedArtifactPreviewJob`.
- **Inbox:** Approval Requests are found in the Inbox, a section of the sidebar below Chat at
  `/inbox`, with one address per item (`/inbox/<id>`). A person who may decide gets the lists To
  decide, My requests and Decided (the last 30 days); everyone else gets their own requests as
  one list, with the state, who decided and the comment. The new operation
  `approval_requests.list_mine` (`GET /api/v1/approval-requests/mine`, scope `conversation:read`)
  returns the caller's own requests. `approval_requests.list` takes `scope=decided`, and
  `approval_requests.count_pending` also answers `mine: { pending, total }`. A migration adds the
  index `approval_requests_client_requester_idx` to `approval_requests` and changes no data.

### Changed

- **Document extraction (breaking config):** the extraction of the document processing
  capability calls its model through the model gateway. The block
  `capabilities.documentProcessing.extraction.provider` is gone, and startup of the API and of
  the document worker stops with this message:
  `'capabilities.documentProcessing.extraction.provider' moved: the provider becomes an entry under 'infrastructure.models' with provider 'google-vertex', 'region', 'model', 'projectId' and 'credentialSecret'; a model binding under 'modelBindings' names that entry; and 'capabilities.documentProcessing.extraction.modelBindingId' names the binding`.
  What to change: add the entry under `infrastructure.models` (`provider: google-vertex`,
  `region: eu`, `model`, `projectId`, `credentialSecret`), add a model binding with
  `agentSelectable: false` that names it, and set `extraction.modelBindingId` to that binding.
  `location` and `endpoint` have no counterpart: `region: eu` selects both.
  `credentialsFileEnvName` becomes `credentialSecret`; a deployment that set
  `DOCUMENT_EXTRACTION_GOOGLE_CREDENTIALS_FILE` keeps the variable and names the secret
  `DOCUMENT_EXTRACTION_GOOGLE_CREDENTIALS`. The API and the agent run worker create every entry
  of `infrastructure.models` at startup, so they now need the key file and the variable too, not
  only the document worker. A binding whose model does not read documents or answer in a JSON
  format, or whose entry states `region: global`, stops startup. Deploy the API and the document
  worker together: the worker's extraction answer no longer carries `usage` and `providerCalls`.
  Rollback: the earlier version does not load the new config, so roll the config back with the
  code. Usage rows written by this version stay valid for the earlier one.
- **Usage of document extraction:** an extraction is recorded by the gateway when the model
  answers, as a call of the product with the purpose `document_extraction`, the conversation and
  the user, and no longer as usage of the agent run after the tool returned. A refused or failed
  extraction call leaves a row with the status `failed`. The provider id of the row is the id of
  the entry under `infrastructure.models`, so a rate card entry for the extraction model must
  name that id. The tool result and the stored extraction no longer carry token counts.
- **Tools (breaking for tool authors):** `ToolHandlerSuccessResult.modelUsage` and
  `ToolModelUsageReport` are removed, and `InProcessToolExecution` no longer takes
  `usageRecorder`. A tool that calls a model does so through the model gateway, which records
  the usage.
- **Navigation:** the sidebar has one entry for a chat. The row "Chat" is gone; "New chat" starts
  a conversation, and inside a conversation its row under "Recent" is the current item. A section
  that stands alone, such as the Inbox, now shows its row, in one group with "New chat". "Recent"
  is the list of the workspace's conversations: it reads the 30 latest, and the next 30 when a
  person scrolls to its end or picks "Load more". A page that fails to load says so and offers
  "Try again". The search in the sidebar's header finds a conversation that is not loaded, and
  an open conversation older than the loaded rows is the first row. During a run the sidebar no
  longer reads the whole list every second: the open conversation follows its event stream, and
  one page is read every two seconds only while another listed conversation runs or a new one
  waits for its title.
- **Branding:** the platform's default favicon is the Catalyst mark, an orange field with a small
  dark square at the bottom right that follows the colour scheme by itself. It replaces the
  shield in `packages/chat-ui/assets/favicon.svg`, the standalone app, the demo client and the
  docs site. A client that ships its own `favicon.svg` keeps it.
- **Views:** a view can no longer move its own frame to another host. Every view is framed in
  a shell document the instance serves at `/app-runtime/view-shell/1/shell.html`, with the
  header `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self'
  'unsafe-inline' 'unsafe-eval' <views.allowedScriptSrc>; style-src 'unsafe-inline'; img-src
  data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none';
  form-action 'none'`. Under `frame-src 'none'` the browser refuses `location`, a refresh tag, a
  clicked link and a download link in a view before it sends a request, to the instance's own
  addresses as well. The shell answers a frame only: another `Sec-Fetch-Dest` gets `403`, and
  both answers carry `Vary: Sec-Fetch-Dest`. A
  reverse proxy must route `/app-runtime/*` to the API, as it already must for the view
  runtime. The view's own policy no longer names `navigate-to`, which no browser enforced.
- **Views:** a view that holds private rows (`private_hydrated_view`) is static. It runs no
  script, because WebRTC lets a script send packets to any host and no browser lets a document
  forbid it. Its body is not the stored HTML: each time it is shown, the interface reads the
  stored HTML with the browser's parser and writes the body from an allowlist of elements and
  attributes. Links lose their address, and scripts, forms, frames, `link`, `meta` and `base`
  elements, event handlers and styles that name an address are left out. Its frame has a fixed
  height and scrolls inside.
- **Views:** a view that runs scripts has `RTCPeerConnection` removed from its window and the
  address taken from every link, and a click on a link that still has one is cancelled. Both
  are hardening and not a boundary. Do not put links into a view.
- **Config assets:** the overview lists the `id` of each agent and skill.
- **Object storage:** every stored byte goes through one port, `ObjectStorage` in
  `@vivd-catalyst/core`: `put`, `get` as a stream with its size, `head`, `delete`,
  `deletePrefix`, `list` in pages and, where the provider can sign, `signedGetUrl`. The new
  package `@vivd-catalyst/object-storage` holds the providers `s3` and `filesystem`; either one
  serves either store under `infrastructure.objectStorage`. No config value moves and no object
  key changes, so a store written by an earlier release is read as it is and a rollback is
  safe. `s3` is now a provider of the platform: a capability no longer registers it, and the
  document-processing capability no longer exports an object store. The byte-store interfaces
  of `capability-sdk` and `tool-execution` and the `createLocalWorkspace...` helpers are gone;
  code that took one takes `ObjectStorage`, and
  `putWorkspaceFile(storage, input)` stores a workspace file. A store fails with `ObjectNotFound`
  or `ObjectStorageUnavailable` and with nothing else: no vendor error, message or address
  crosses the port. A setup failure of the store (missing bucket, refused credentials,
  unreachable endpoint) still answers an upload with `422`; its message names the config entry
  and no longer the bucket. `deletePrefix` and `list` refuse a prefix that does not end with
  `/`, so `users/usr_1` can never reach `users/usr_10/`, and refuse one that holds `.`, `..`, an
  empty segment, a leading `/`, a backslash or a null byte instead of rewriting it. A signed read address lives at most
  300 seconds and is never logged; nothing in the platform asks for one yet.
- **Rights:** every rights check of the API and of tool calls is answered by one evaluator,
  `evaluateAccess` in `@vivd-catalyst/core`. `InProcessToolExecution` takes an optional
  `authorizer`; `ChatServerOptions.stores` needs the `access` store, which
  `createPostgresStores` provides.
- **Deleting an account or a Shared Workspace:** a deletion now finishes by itself. The
  request closes the account or the workspace at once: the user can no longer sign in and is
  listed as "Being deleted", the workspace is gone from every selector and its conversations
  accept nothing. When stored data cannot be removed at once, the request answers `202`
  without a body instead of `409`, and a job (`account.delete`, `workspace.delete`) tries
  again with a growing wait, up to 50 times over about ten days. When nothing is left to wait
  for, the request answers `200` as before. A repeated request answers `202` and starts
  nothing new. After the last attempt the job is dead, the audit log holds
  `user.deletion_stalled` or `collaboration_workspace.deletion_stalled`, the account or
  workspace stays closed, and deleting it again starts a new job. The dead job is kept until
  the account or workspace is gone, also past the 30 days other dead jobs are kept. A closed
  account leaves its Shared Workspaces and access requests with the first pass. Of two owners
  who delete their accounts at the same moment, the second is refused as the last owner; the
  same holds for a deletion and a role change or removal at the same moment. The first pass
  asks the agent runs of the user or in the workspace to stop, and a run still working stores
  no further message: every write into a conversation of a closed account or workspace is
  refused, whichever runtime the instance uses. The account or the workspace is removed only
  when these runs have ended and the stored data of every conversation the user created is
  gone. That includes execution workspace data on an instance that has the feature off: rows
  without stored objects are cleared, and stored objects that cannot be removed fail the
  attempt. An attempt that removes nothing fails, so a deletion that cannot go on ends as a
  dead job with its `deletion_stalled` event. An administrator who changes a user being
  deleted, or writes a grant for one, gets `409 CONFLICT`, and such a user holds no rights.
  The grant and deny rows a user holds go with the user; rows the user wrote for others and
  Namespaces the user registered stay and keep the user's id. The audit log records
  `user.deletion_requested` and `collaboration_workspace.deletion_requested` when a deletion
  is accepted; `user.delete_failed` and `collaboration_workspace.delete_failed` are no longer
  written. A client that calls one of the three delete operations must accept `202`. Upgrade:
  migration `0035_deletion_requested` adds a nullable column to two tables. Rollback: the
  previous release does not know the mark, so a closed account could sign in again and a
  closed workspace would be listed again. Let the deletion jobs finish before rolling back.
  These two queries list what is still closed, and both must return nothing:
  `select id from product_users where deletion_requested_at is not null` and
  `select id from collaboration_workspaces where deletion_requested_at is not null`.
- **API:** a call refused for a missing right answers `403 FORBIDDEN` with the message
  `Missing the right '<action>'` and `details.action` and `details.reason`, on every route.
  The message was `Missing permission '<permission>'` and named the legacy permission. The
  routes ask the server's authorizer, a new server option `authorizer` whose default is the
  rights evaluator over the instance's access store. `details.reason` is `no_grant`,
  `denied`, `holder_inactive` or `unknown_action`.
  routes ask the server's authorizer, a new server option `authorizer` whose default decides
  as before.
- **Logs:** the log record of a failed job keeps the class and the code of its error with the
  job id and kind, and no longer the error with its message and stack. The job row keeps the
  error code and message it kept before.
- **Logs:** the log record of a failed tool handler or operation keeps of a database error
  its SQLSTATE code, constraint and table and no longer its message, which can quote
  rejected values.
- **Interface, Settings:** the Settings dialog, the workspace settings dialog and the
  administration panel are one Settings area with a rail of pages in three groups: You (Profile,
  Language and appearance, Security), Workspace (General, Members, with the shared workspace
  they change named under the group) and Instance (Users, API access, Usage, Audit). A user
  sees only the groups and pages they may open; the server still decides every right. Config
  is the area Build in the main rail and keeps `/admin/config`. Pages live at
  `/settings/<group>/<page>`; `/settings`, `/admin`, `/admin/users`, `/admin/usage`,
  `/admin/audit` and `/admin/api-access` lead to the new addresses. The theme choice gains
  "System". **Breaking for a host that assembles the shell:** the option `adminPanel` of
  `renderStandaloneChatApp` and `ChatShell` is `administration`, and
  `@vivd-catalyst/chat-ui/admin` exports `administration` in place of `superadminPanel` and
  `SuperadminPanel`; pass `administration` from that entry. The type `ChatShellAdminPanel` is
  `ChatShellAdministration`, and `canViewSuperadminPanel` is gone (use
  `canViewAdministrationPanel`).
- **Model calls:** an agent run reaches its model through one model gateway. The gateway
  resolves the model binding, checks what the provider's adapter declares it can do, admits the
  call, retries it and records its usage. Three things change for an operator. Every admitted
  call leaves one usage event, also one that failed, was stopped or timed out; that event has
  no tokens and no cost and counts towards `modelCallsPerDay`. A provider's error is logged
  once as `model_provider.error` with its kind, status, code, request id and the provider's
  message cut to 300 characters on one line; the message is in no error a user or an API
  caller receives. A call that asks an entry for something its adapter does not declare fails
  with a validation error before the provider is called.
- **Breaking, extension API:** a provider on the `models` port returns a `ModelAdapterFactory`
  whose adapter has `capabilities(model)`, `complete` and `stream` and throws
  `ModelProviderError`; `ModelProvider`, `ModelProviderFactory` and
  `ModelProviderRegistry` are gone. `LocalAgentRuntime` takes `modelGateway` in place of
  `modelProvider` and `usageGovernance`. `ModelUsageEventInput` carries an `attribution` in
  place of `conversationId`, `agentRunId` and `agentName`, and `runModelCall` takes the call's
  instance and attribution.
- **Breaking, release config:** `webAccess.search.mode` and `webAccess.search.managedProvider`
  are removed. Delete both before the upgrade; `webAccess.search.enabled` is the only switch.
  A config that still sets one does not start and says: "Client instance config is invalid:
  webAccess.search: 'webAccess.search.mode' was removed: whether a model can search the web is
  declared by its provider, and 'webAccess.search.enabled' is the only switch. Delete the key".
  With both keys the one message names both ("'webAccess.search.mode' and
  'webAccess.search.managedProvider' were removed: ... Delete the keys"). Whether a model can
  search is declared by its adapter: an `openai-compatible` entry with `api: responses` can,
  one on `chat_completions` and the `deterministic` provider cannot. Saving an agent that
  lists `web_search` on a model that cannot is refused with "Agent '<name>' references
  web_search but the model of this agent cannot search the web".
- **Usage:** conversation titles and approval checks are model calls through the gateway and
  now appear in usage. Each leaves one record, also when it failed, timed out or was refused
  by the provider, and counts toward the daily call limit and the other limits of the
  instance. Such a record carries the purpose (`conversation_title`, `guardrail_judge`) where
  an agent run's record carries the agent name, names the conversation when one caused the
  call, and names no agent run. Everything is counted toward the instance's limits. A title
  that a limit
  refuses fails only its job and never a user's message. An approval check that a limit
  refuses blocks under `onFail: block` with the reason "Check '<id>' could not run because
  the model usage limit of this instance is reached. Try again later."; under `onFail: warn`
  the request is stored as not evaluated.
- **Usage:** a title call ends after 60 seconds like an approval check, is recorded once
  without tokens and frees its job slot and its place in admission. The gateway enforces the
  deadline of a call itself, also against a provider that ignores cancellation.
- **Database:** migration `0036_usage_system_calls` drops `NOT NULL` from
  `model_usage_events.conversation_id` and `agent_run_id`; it moves no data. In the API,
  `conversationId` and `agentRunId` of a usage event are optional. **Rollback:** the previous
  release keeps summing usage and admitting calls correctly with such rows, but its Usage
  page fails for as long as a record of a title or an approval check is among the recent
  events it lists.
- **Usage:** every model call is recorded with its provider, the region of the provider entry
  (`eu`, `global`, or none for a provider inside the instance), the model binding it named,
  the user and the workspace. A title or an approval check is recorded with its purpose. The
  Usage page lists the caller and, in one column, the provider and the region of the recent
  calls, and the summary answers a new optional field `attributedUsage`: the last 30 days by
  day, model, provider, region and purpose or agent. A usage event in the API adds `status`
  and the optional fields `purpose` and `region`. The sums of the page are read from daily
  sums that are kept as each call ends; the page reads no usage record except the 25 newest.
- **Usage:** a call is admitted against the limits of the instance in the database, in one
  statement on two counter rows, the day's and the month's. Several API and worker processes
  together admit no more than the limits allow, for calls, tokens and spend. No process waits
  for a lock per instance, and admission reads no usage record. At admission a call reserves
  what it can use at most: its input by the size of the request, 16,000 output tokens, and
  both at the highest price the rate card has for the model. When the call ends, the
  reservation is replaced by what it used. **Changed behaviour:** a call is refused when its
  reservation no longer fits a token or spend limit, so a limit is reached slightly before it
  is used up. A token limit at or below the 16,000 reserved output tokens would admit no
  call: the config is refused with a message that names both numbers. With a spend budget, a
  model without a price on the rate card is refused; a `deterministic` provider needs no
  price and its calls reserve no cost. A cost that is not whole, such as one whose provider
  reported no cached tokens, no longer stops every later call: it counts at the highest
  price. The limits are protective safeguards: a call settles its real usage, which can be
  more than it reserved, so a limit can be passed by the calls in flight times what each
  used beyond its reservation (`MODEL_CALL_RESERVED_OUTPUT_TOKENS`).
- **Usage:** a usage record has a status. `pending`: the call was admitted and has not ended;
  the Usage page shows it as "Running". `settled`: it ended with usage, and the page says
  whether the provider reported it, reported none, or it is estimated. `failed`: it failed,
  was stopped or timed out before any answer arrived; it counts as one call, uses nothing
  and shows "Failed". A stream that is stopped or breaks off after its answer began is
  settled with the usage its provider had reported by then, and otherwise with an estimate
  of three characters a token, one token for a character outside the Latin alphabet, and
  marked `estimated`.
  `abandoned`: its process went away; it shows "Abandoned". A job
  (`usage.recover_abandoned_calls`, every 10 minutes) takes a call that is still `pending`
  six hours after its admission as abandoned and releases what it reserved.
- **Usage and deletion:** usage records are kept for the accounting of the instance. When an
  account is deleted, the user is removed from its usage records together with the
  conversation id, the run id, the operation id and the correlation id; the amounts, the
  model, the provider and the agent or purpose stay. When a workspace is deleted, the
  workspace is removed from its usage records and the amounts stay. The database enforces
  both: no user and no workspace row can go while a usage record still names it. A call that
  was being admitted while its workspace was deleted no longer fails with a database error.
- **Database:** migrations `0041_usage_attribution`, `0042_usage_attribution_indexes` and
  `0043_usage_attribution_validate` add the nullable columns `purpose`, `region` and
  `binding_id` to `model_usage_events`, drop `NOT NULL` from `agent_name`, tie `user_id` and
  `collaboration_workspace_id` to their tables with `ON DELETE SET NULL`, and add one partial
  index for each of the two. No column is dropped. After the upgrade a background job fills
  older usage rows. Until it ends, older rows show no region. The job
  (`usage.backfill_attribution`) runs in the API and worker processes, 5,000 rows per
  statement, and may be interrupted at any time. A row whose provider and model are no longer
  configured keeps no region. `0042` is the first migration that builds an index with
  `CREATE INDEX CONCURRENTLY`; a migration step that finds another step running now asks for
  the migration lock again every 250 ms and no longer waits inside a statement, because the
  index build would wait for that statement and the two would stop each other.
- **Database:** migrations `0044_usage_counters` and `0045_usage_pending_index` add the tables
  `model_usage_counters`, `model_usage_daily_rollups` and `model_usage_maintenance`, the
  columns `status` (default `settled`), `counted_tokens` and `counted_cost_micros` on
  `model_usage_events`, and a partial index on the calls in flight. No column is dropped.
  After the upgrade the job `usage.reconcile` reads every usage record once and builds the
  daily sums; until it ends, the Usage page shows no sums for the days before the upgrade
  (about 3 seconds per million records). It then runs once a day and at every start, reads
  the records of the month and corrects the counters and sums by what it finds. **During a
  rolling upgrade** a process of the previous release writes usage records that are in no
  counter and no sum, so a limit can be passed by what those processes admit. Stop the
  previous release before the new one takes calls, or accept that gap until the next run of
  `usage.reconcile`, which closes it. The attribution backfill keeps its place in the
  database: a process that is killed loses one batch of 5,000, and the next tick, at most 10
  minutes later, goes on from there. After a pass without a change it reads the records
  again once a day until the job is removed. **Rollback:** the previous release runs against
  the migrated database. Its Usage page works: a title or an approval check still carries its
  purpose as agent name for this release. Calls it admits are counted by `usage.reconcile`
  after the next upgrade. **Contract step, a later release:** stop writing the agent name of
  a call the product made for itself, and remove `usage.backfill_attribution`.
- **Breaking, extension API:** `ModelCallGovernance` is `admitModelCall` and
  `settleModelCall` in place of `runModelCall`; a call that ended without an answer is
  settled without usage. `ModelCallAdmission` adds `request`, the size of the request.
  `ModelUsageEventStore` replaces `summarizeModelUsageEvents` with
  `summarizeModelUsageHistory` and `summarizeRecentModelUsage` and adds
  `admitModelUsageEvent`, `settleModelUsageEvent`, `listPendingModelUsageEvents`,
  `reconcileModelUsage`, `readModelUsageMaintenance`, `writeModelUsageMaintenance`,
  `clearUserFromModelUsageEvents`, `clearWorkspaceFromModelUsageEvents` and
  `backfillModelUsageAttribution`.
- **Breaking, extension API:** `ChatServerOptions` takes `modelGateway` in place of
  `modelProvider`; `ApprovalCheckRunner` takes `{ clientInstanceId, config, modelGateway }`;
  `reasoningEffortChoiceForBinding` takes the efforts the model's adapter declares as its
  second argument, and `createSafeConfigView` offers a reasoning effort choice only when it is
  given `reasoningEffortsOfBinding`. `WebAccessSearchModeConfig`,
  `OPENAI_WEB_SEARCH_PROVIDER_TOOL_ID` and the gateway's `unsettled` door are gone.
- **Retention:** a conversation's deletion date counts from the last message a user sent, no
  longer from its creation: accepting a message moves the date to `retention.conversationDays`
  later, in the transaction that stores the message. Opening, reading, renaming, moving, the
  generated title and background jobs do not move it. `retention.extendOnActivity: false`
  keeps the date set at creation as a fixed maximum age. Check what an instance promised its
  users before upgrading: the default is `true`. A conversation within seven days of its date
  shows one line above the composer with the deletion date. The line and the clock in the list
  cover at most half the retention period, so a new message always clears them; where a message moves the date,
  the line says that a new message keeps the conversation. The safe config answer carries
  `retention.extendOnActivity`, optional for clients of an older API.
- **UI library:** `Banner` has the layout `line`, one quiet sentence without a box whose icon
  alone carries the tone.
- **Interface, navigation:** the rail is 280 px wide and collapses to a strip of icons with one
  visible control; under 768 px it is a drawer the header opens. Its filter field is gone:
  Search in the rail, or ⌘K (Ctrl+K), opens a command palette that offers New chat, the
  conversations of the active workspace, whose titles it searches on the server, and under
  "Go to" the Settings pages the viewer may open and Build. New chat also has ⌘⇧O
  (Ctrl+Shift+O). The account menu in the rail's footer leads to Profile and to Language and
  appearance and holds the theme switch and sign out. The row menu of a conversation shows
  while the pointer or the keyboard is on the row; the retention clock shows all the time.
  Before anything is typed the palette lists the eight most recent conversations. The list shows placeholder
  rows while it loads and a retry when the load failed. A skip link leads past the rail.
- **Interface, surface:** closing a surface returns the focus to what opened it, a surface that
  covers the conversation takes it out of the tab order, and Escape closes a menu or the
  palette before the surface.
- **UI library:** `Sidebar` is one `nav` landmark where it was an `aside` around a `nav`.
  `NavItem` gains `trailing` and `shortcut`, `IconButton` gains `shortcut`. New:
  `CommandPalette`, `SkipLink` and the token `--layout-sidebar-collapsed`.
- **Interface, default theme:** an instance that sets no `ui.theme` or `ui.darkTheme` now shows
  warm paper neutrals with one terracotta accent (light `#fdfbf7` page, `#f6f3ec` sidebar,
  `#b5573a` accent; dark `#1c1a17` page, `#131210` sidebar, `#d98c6c` accent). An instance
  with its own theme keeps its seven colours; the names of the inputs and tokens are
  unchanged. On every instance, buttons and the segmented control are pills and filled buttons
  carry a hairline and a faint edge. The primary and the danger button are tinted instead of
  solid: a soft fill of the accent or of red, its line and its strong text. The send button
  in the composer is filled with the text colour. A hovered ghost button keeps the text
  colour, and an avatar without a colour of its own is a neutral grey with initials in the
  text colour. One derived token is new: `--shadow-control`.
- **Chat:** the display panel is the surface slot. A tool display or a file preview stands
  beside the conversation while both sides keep 380 px, which is from 760 px of main area, and
  covers the main area below that, where its header offers "Show chat" alone. The former drawer
  below 1024 px is gone. The width is free, is remembered in the browser per kind of surface
  and is clamped so neither side falls below 380 px. The handle is the line between the two
  sides: the arrow keys move it 16 px, Home and End go to the limits. Fullscreen shows "Show
  chat" beside its controls. Nothing animates when the surface opens or resizes.
- **Chat UI:** `ToolDisplayPanel` and `ToolDisplayPanelFrame` are replaced by `SurfaceSlot` and
  the library's `SurfaceFrame`. The standalone app builds its routes from one table,
  `chat-ui/src/routes.ts`; every address keeps its path.
- **Limits:** five defaults that failed honest use are raised. A model call is tried three
  times, waiting about 1 s and then about 4 s, so a run survives two provider errors in a row
  (a rate limit waits longer, see Fixed). An approval check may take 60 s (was 10 s); a blocking rule that runs out of time says
  so. A spreadsheet previews up to 50,000 cells per sheet or range (was 5,000), and the stored
  failure names the limit. A preview embedded in a message is read up to 500 pages (was 200),
  the same ceiling the preview worker uses, exported as `ARTIFACT_PREVIEW_MAX_PAGES` from
  `@vivd-catalyst/core`. A Mailjet send may take 30 s (was 10 s).
  A provider's `Retry-After` replaces the fixed wait up to 60 s; a longer one fails the run at
  once, and no attempt or wait starts past a run's deadline. The preview renderer version is
  `preview-contract-v2`, so every stored preview, including sheets that failed under the old
  cell limit, is rendered once more the next time it is opened.
- **API contract (breaking):** `@vivd-catalyst/api-contract` no longer exports the constant
  `openApiDocument`; call `createOpenApiDocument()`. `createOpenApiDocumentFromOperations`
  takes the operations alone: title and version are those of the release. An operation that
  answers a file states its content type (`blob("text/html")`), and an operation of a
  signed-in caller may state `scope: null` when it asks for no scope.
- **API (operator-relevant):** every operation is rate limited, against spamming and guessing
  only. A call is counted per operation and per caller: the signed-in person or service where
  the operation authenticates one, the client address where it does not. The defaults are 6000
  calls a minute to a reading operation and 1200 a minute to a changing one. A host backend's
  session-token calls are counted under its server credential, 6000 a minute. A caller over a
  limit receives 429 with the code `RATE_LIMITED`, `details.retryAfterSeconds` and a
  `Retry-After` header; the chat interface waits that long and sends an upload again. The new
  release config section `rateLimits` sets `enabled`, `readPerMinute`, `writePerMinute`,
  `signInPerAccountPerMinute` and `signInPerAddressPerMinute`; an instance without the section
  gets the defaults. The counters live in the API process: they start empty after a restart,
  and an instance must run one API process. The client address is taken from
  `X-Forwarded-For` only when the direct peer is a loopback or private address, so the reverse
  proxy in front of the API has to pass the real client address on. Where Caddy sits behind
  another proxy, its Caddyfile needs `servers { trusted_proxies static private_ranges }`, or
  every caller is counted as one address.
- **Sign-in (operator-relevant):** sign-in and password reset are limited to
  10 tries a minute on one account from one client address, and 300 a minute from one address
  whatever the account, so an office behind one address is not locked out by one person. A
  refused API key or server credential is counted per address, 60 a minute, on a counter the
  accepted credential never touches. The sign-in routes under `/api/auth/*` are counted by the
  API before a password is checked and answer with the same 429 as every operation. Until now
  their limit depended on `NODE_ENV=production`, which the reference Compose files do not
  set, so it was off. Reset mails for requests from one client address are capped at 200 an
  hour, up from 20; the cap of three an hour per mailbox stays.
- **Server runtime (breaking):** `createChatServer`, `ClientInstanceApp` and the document
  worker expose `{ fetch(request), listen, close }` and no web framework type.
  `ClientInstanceApp.server` and the worker's `server` are gone: call `app.fetch(new
Request(url))` where code called `app.server.inject(...)`. `listen` resolves with the base
  URL. `createRoute` and `Route` are no longer exported from `@vivd-catalyst/chat-server`.
  The object `createStandaloneAuthRuntime` returns has `routeKind(pathname)`, which the server
  uses to count calls to the sign-in routes.
- **Infrastructure (breaking):** every provider an instance runs on is named in the new
  `infrastructure` section of the instance config, one provider per port: `secrets`, `models`,
  `mail`, `objectStorage.files`, `objectStorage.workspaces` and `sandbox`. The keys
  `modelProviders`, `mail`, `executionWorkspaces.runner` and
  `capabilities.documentProcessing.objectStorage` moved there. Config that still carries one of
  them does not load: startup stops with a message that names the key and its new place. There
  is no transition release, so deploy the config change together with this version. What to
  change:
  - `modelProviders` (a list) becomes `infrastructure.models` (a map): `id` is the map key,
    `type` becomes `provider`, the key's `…EnvName` field becomes `credentialSecret`, the
    organization's becomes `organizationSecret` and `compliance.residency` becomes `region`.
    A residency of `unknown` has no counterpart: state where the provider processes data, and
    `global` when no EU processing is agreed. An id made only of digits is refused, because
    such a key is read before the others and would move the default provider; rename it, also
    where an agent names it.
    Maps merge key by key across `extends` files, so delete an entry of a base file that an
    overlay used to replace. At least one entry is required; the implicit `deterministic`
    default is gone.
  - `mail` becomes `infrastructure.mail`: the two `…EnvName` fields become `apiKeySecret` and
    `apiSecretSecret`, and an instance without mail leaves the key out instead of
    `enabled: false`.
  - `executionWorkspaces.runner` becomes `infrastructure.sandbox`: `mode` becomes `provider`
    (`docker` or `local`). `networkMode` and `readOnlyRootFilesystem` are fixed and no longer
    settings. `EXECUTION_WORKSPACE_RUNNER_IMAGE` still replaces the image of a `docker` sandbox
    and is ignored for any other. A Docker sandbox with an `endpoint` runs on another host and
    must state a `region`; without an endpoint it must not.
  - `capabilities.documentProcessing.objectStorage` becomes `infrastructure.objectStorage.files`:
    `kind` becomes `provider`, the vendor's `region` becomes `bucketRegion`.
    `DOCUMENT_OBJECT_STORE_BUCKET`, `DOCUMENT_OBJECT_STORE_REGION` and
    `DOCUMENT_OBJECT_STORE_ENDPOINT` still replace the entry's values.
  - The variables `EXECUTION_WORKSPACE_OBJECT_ROOT` and `ARTIFACT_PREVIEW_OBJECT_ROOT` are no
    longer read. Name the directory in `infrastructure.objectStorage.workspaces`
    (`provider: filesystem`, `root`), and mount the same directory into the API and its workers.
    Enabled execution workspaces need this entry and `infrastructure.sandbox`. A deployment
    that set the directory through one of the two variables, in Compose or in an environment
    file, moves that path into config and removes the variable; the files stay where they are
    as long as `root` names the same directory.
  - A provider that sends data outside the instance (`openai-compatible`, `mailjet`, `s3`) must
    state `region: eu` or `region: global`; one that keeps data inside must not.
- **Secrets (breaking for integrators):** every secret is taken from one secret resolver, by
  name. The `environment` provider reads the variable of that name and otherwise the file named
  by `<NAME>_FILE`, so a mounted secret works for every secret, including `DATABASE_URL`. Config
  fields that take a secret end in `Secret` and hold its name, never its value. The S3 store
  always takes its credentials by name (default `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`); the AWS credential chain and the built-in S3Mock credentials are no
  longer used. A deployment that reached S3 through an instance role or another source of the
  AWS credential chain must now provide an access key pair as two named secrets, and a local
  S3Mock that ran without credentials needs both variables set to any value. A name must read
  as an environment variable name (upper-case words joined by underscores, at most 64
  characters); anything else is refused and never repeated in a message, so a credential
  pasted where a name belongs does not reach a log. The same holds for a data source's
  `connectionRef: env:NAME`. A secret whose `<NAME>_FILE` is set and whose file cannot be read
  or is empty stops startup, also for a secret the instance may leave unset. An instance whose
  config carries `auth.sessionToken` no longer starts without `CHAT_SESSION_TOKEN_SECRET` and
  `CHAT_SERVER_CREDENTIAL`: before, it started without session-token sign-in when another
  sign-in path existed. Set both, or remove `auth.sessionToken`. A seed user's
  `passwordEnvName` follows the same naming rule.
  `createClientInstanceApp`, the worker factories and `seedStandaloneAuthUsers` accept a
  `secrets` resolver. `@vivd-catalyst/data-source` no longer exports `createEnvSecretResolver`,
  `createDataSourceRegistry` is asynchronous and takes `secrets`, and
  `createModelProviderRegistry` is asynchronous and takes the instance's provider `registry`. A capability receives `secrets`, `logger` and `objectStorage` in its context and
  may bring provider definitions in `providers`. An artifact preview `sourceReaderFactory`
  receives `context` (the resolver and the logger) for the store it creates.
- **Config API:** a selectable model in the safe config view carries `region` (`eu` or
  `global`) in place of `residency`.
- **Startup messages:** an invalid instance config names the first failing key in the error
  message, not only in its details.
- **Database (operator-relevant):** `infrastructure.database.poolSize` sets how many PostgreSQL
  connections each process of the instance keeps at most; the default is 10, the value until
  now. `createPlatformStore` requires `poolSize` (breaking for integrators that call it).
- **Run start:** a repeated run start with the same idempotency key waits up to 10 seconds for
  the first one, in steps of 100 ms, before it answers 409; until now it waited one second.
- **Jobs:** `JobWorker.idle()` resolves when the worker has no pass and no job in flight and
  sleeps until its next poll.
- **Jobs (operator-relevant):** the API process runs a job executor on the new table
  `platform_jobs` (one migration, which only creates the table and moves no data). It replaces
  the three interval timers for conversation expiry, workspace cleanup and run recovery, and
  the in-process title generation. A job survives a restart: it is leased, retried with
  backoff and recovered when its worker dies. `createClientInstanceApp` starts the worker in
  `listen()` and stops it in `close()`; `createJobWorker` is exported from
  `@vivd-catalyst/client-assembly`. On SIGTERM the worker stops claiming, waits up to 20
  seconds for running jobs and gives the rest back, so the Compose service `api` needs
  `stop_grace_period: 30s`. Ended job rows are removed after 7 days (succeeded, cancelled) or
  30 days (failed, dead).
- **Jobs (operator-relevant, breaking for integrators):** file previews and document
  preprocessing run on the job executor, as the kinds `artifact_preview.render` (two attempts,
  30 seconds apart, a lease of 5 minutes) and `conversation_attachment.preprocess` (three
  attempts, 30 seconds doubling up to 10 minutes, a lease of twice the preprocessing timeout
  and at least a minute). The preview row and the attachment stay the record the interface
  reads; the row and its job are written in one transaction. No migration. A storage
  or database error, or a converter killed by a signal, is now tried three times before the
  attachment shows as failed, and a conversion that timed out twice; a refused or corrupt
  document, such as an unsupported format or a converter ending with an exit code, fails at
  once as before.
  - The preview worker no longer reads `ARTIFACT_PREVIEW_POLL_INTERVAL_MS`,
    `ARTIFACT_PREVIEW_LEASE_DURATION_MS`, `ARTIFACT_PREVIEW_LEASE_RENEW_INTERVAL_MS` and
    `ARTIFACT_PREVIEW_MAX_ATTEMPTS`, and the document worker no longer reads
    `DOCUMENT_WORKER_POLL_INTERVAL_MS`. Remove them from the environment.
    `ARTIFACT_PREVIEW_CONCURRENCY` and `DOCUMENT_WORKER_CONCURRENCY` stay: they are how many
    jobs one process runs at once.
  - On SIGTERM both workers give their running jobs back, so the Compose service of the
    document worker needs `stop_grace_period: 30s`, as the preview worker has it.
  - This release can run beside the previous one and be rolled back to it. A job copies its
    lease onto the old lease columns of its row, so a worker of the previous release leaves
    the row alone; the job leaves a row alone while a worker of the previous release holds it;
    and the schedule `platform_jobs.adopt_legacy` gives every unfinished row without a job
    its job once a minute, which covers rows the previous release's API writes. The copy, the
    schedule and the old lease columns go in a later release.
  - `@vivd-catalyst/tool-execution` exports `createArtifactPreviewJobHandler` in place of the
    class `ArtifactPreviewWorker`. `ClientInstanceArtifactPreviewWorker.worker` is a
    `JobWorker` and its `stop()` takes no argument. The file store loses
    `claimNextArtifactPreviewJob`, `recoverStaleArtifactPreviewJobs` and
    `claimNextQueuedConversationAttachment`; a row is claimed by id with
    `claimArtifactPreviewJob` and `claimConversationAttachmentForPreprocessing`.
- **Agent Runs (operator-relevant, breaking for client assemblies):** an Agent Run executes
  only as a claimed job of the kind `agent_run.execute` (one attempt, a lease of 90 seconds
  renewed every 15 seconds). The run row stays the record the interface reads; the row and its
  job are written in the transaction that accepts the message. No migration. The option
  `agentRuntimeMode` of `defineClientInstance` and `createClientInstanceApp` is removed, with
  the runtime that kept runs in the memory of the API process. Its place takes
  `agentRunWorker`: `"in_process"` (the default) serves the runs from a second job worker
  inside the API process, `"separate"` leaves them to the processes started with
  `runAgentRunWorker`. A deployment that set `agentRuntimeMode: "worker"` sets
  `agentRunWorker: "separate"`; one that set `"local"` or nothing removes the option. The
  environment variables of the worker are unchanged: `AGENT_RUN_WORKER_CONCURRENCY` (runs one
  process executes at once, default 8, read by the API process too when it serves the runs),
  `AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS` and `AGENT_RUN_WORKER_ID`.
  - A run is never executed twice. Every event and every message of a run is stored in a
    transaction that first reads the job row under a share lock and requires its lease token
    and an unexpired lease, so a worker that lost its lease stores nothing more, whatever it
    still does.
  - When the worker of a run is killed, nobody can tell for up to 90 seconds: the reply stands
    still and the conversation takes no message. Then the next pass of any job worker of the
    instance, the one of the API process included, marks the job dead and, in the same
    transaction, fails the run with the code
    `AGENT_RUN_WORKER_LOST` and the category `runtime_interrupted`, stores the event
    `run_failed` and the audit event `agent_run.recovered`. The interface shows the reply as
    interrupted with what was streamed so far, and the conversation takes the next message.
    The message is not sent to the model again. This needs no second Agent Run worker: the
    API process buries the jobs of lost workers without executing any. A run that another
    worker holds under a live lease, one of the previous release during a rolling deploy, is
    left alone when the job beside it dies.
  - On SIGTERM a worker takes no new run and lets its runs go on for the drain time, as
    before; a run that is still going then fails with `AGENT_RUN_RUNTIME_INTERRUPTED` and is
    not executed again. A second signal ends the drain at once. An API process that serves
    the runs itself stops them at once when it closes.
  - A cancellation reaches the worker within about a second: the job reads its row once a
    second, and at once when the API and the worker are one process. The cancel route answers
    with the status `cancelling` for a run that has started, in every topology; the run is
    `cancelled` once the worker has stored what the model wrote so far. A run that was asked
    to cancel ends as cancelled even when its completion arrives first.
  - A run that stores no event for 30 minutes fails as interrupted. A run that no worker took
    within 10 minutes of its acceptance fails with the code `AGENT_RUN_NOT_STARTED`; the
    conversation takes the next message and the interface says that the reply could not be
    started. The previous release failed such a run after 30 minutes. The limit is the
    constant `AGENT_RUN_MAX_QUEUED_MS`. It must stay above the longest wait of a healthy
    instance, which grows with the runs queued ahead divided by the slots of all worker
    processes, times the length of a run. Instance > Jobs marks a kind whose due jobs have
    waited a minute with none running as "No worker takes these"; for `agent_run.execute` that
    is the missing Agent Run worker. `/ready` does not change.
  - The answer of a run and the end of the run are stored in one transaction. A worker that is
    killed at the end of a run leaves either the answer with a completed run, or a failed run
    without the answer; the previous state of this release could show the full answer beside
    a failed run. Every event the worker takes after the answer is held with it until the
    event that ends the run, since such an event may be older than the answer. Above
    `AGENT_RUN_HELD_END_MAX_EVENTS` (1000) held events the answer and those events are stored
    at once and that run goes on without this guarantee.
  - An approval request a tool proposes and a provider continuation the runtime drops carry
    the lease of the run's job into their transaction (`RuntimeCallContext.runFence`), like
    the events and messages, so a run that lost its lease leaves none of them behind. Usage
    settlement and audit are not fenced, on purpose: a model call that was made and a tool
    that ran are recorded whoever holds the run. Workspace commands, artifacts and files are
    not fenced; the run checks its lease before each tool call.
  - A stopped reply is named "The reply was stopped." in the interface, in English and
    German, where it showed the reason code of the request.
  - This release can run beside the previous one with the worker topology and be rolled back
    to it. A job copies its lease onto the lease columns of its run row, so a worker and the
    API of the previous release leave the row alone; a job that finds its run held by a
    worker of the previous release ends without waiting; and the schedule `agent_run.adopt`,
    served by the API process and by every Agent Run worker, gives every queued run that
    has no live job a job every 15 seconds, which covers runs the previous release's API
    accepts. The same tick fails a started run as lost when the lease on its row has run out
    and no job of it is running, so a run whose previous-release worker died ends within 15
    seconds of its lease, also while no Agent Run worker is up. After a
    rollback the previous release's worker claims the queued runs this release accepted, and
    its recovery fails the runs this release's worker held once their lease has run out. An
    API of the previous release that kept runs in its own memory (`agentRuntimeMode:
    "local"`) cannot run beside this release: stop it before the new processes start.
  - Rollback in the single-process topology: the previous release with `agentRuntimeMode:
    "local"` executes only runs it accepted itself. A run that was in flight on this release
    at the rollback stays `running` on the previous release until that release's recovery
    fails it, up to 30 minutes later, and its conversation answers the next message with 409
    until then. Let the runs end before a rollback, or expect that wait.
  - Compose: give an Agent Run worker a `stop_grace_period` of at least its drain timeout plus
    30 seconds (15 minutes 30 seconds with the default `AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS`),
    or Docker kills it mid-drain and its runs fail as lost after the lease time instead of
    ending. The recommended `AGENT_RUN_WORKER_CONCURRENCY` is the default of 8: a worker
    process with 8 runs in progress was measured at 201 MB.
  - The schedule `agent_run.recover` is gone. The kind stays registered with a handler that
    does nothing, so the tick the previous release left behind ends; it is removed in a later
    release.
  - `@vivd-catalyst/agent-runtime` exports `createAgentRunJobs`, `createLocalAgentRunExecutor`
    and `createAgentRunSignal` in place of the class `AgentRunWorker` and
    `createWorkerLocalAgentRunExecutor`. `@vivd-catalyst/chat-server` no longer exports
    `RunRecoveryWatchdog` or the job option `runRecovery`. `AgentRuntime.holdsRun` is removed.
    The run store loses `claimNextAgentRun`, `heartbeatAgentRun`, `recoverExpiredAgentRuns`,
    `listStaleActiveAgentRuns` and `recoverStaleAgentRun` and gains `claimAgentRunForJob`,
    `renewAgentRunJobLease`, `failLostAgentRun`, `failAgentRunsQueuedTooLong`,
    `failAgentRunsWithoutWorker`, `appendClaimedAgentRunEnd` and `listAgentRunsWithoutJob`; the fenced
    writes take `lease: { jobId, leaseToken }`. `UserStore` gains `getUser`.
    `JobWorker.stop` takes `{ drainMs }`. `@vivd-catalyst/core` gains `defineJobBurial`, which
    registers only the burial of a kind's dead jobs in a process that does not execute the
    kind, and `createAgentRunUpkeepJobs`, which `createChatServerJobs` registers.
- **Jobs (operator-relevant, breaking for integrators):** workspace commands run on the job
  executor, as the kind `workspace.command` (one attempt, a lease of 2 minutes renewed every 30 seconds, one command
  per workspace at a time, so two commands of a workspace run in the order they were queued).
  The command row stays the record a tool reads; the row and its job are written in one
  transaction. No migration. A command is never run twice: when its worker dies, the command
  fails with the code `WORKSPACE_COMMAND_WORKER_LOST` and the category `worker_lost`, in place
  of `WORKSPACE_COMMAND_STALE`, once the lease has run out. What `workspace.exec` returns is
  unchanged. Instance > Jobs offers no retry for a `workspace.command` job: the job of a
  command that has ended does nothing.
  - A cancelled command ends within about a second: the job reads its row once a second and
    stops the process group. A cancellation that arrives after the process has ended does
    not change the record: the command is completed or failed with its real result. A tool
    that waits for a result still asks the row every 500 ms; it is not woken by a
    notification yet. On SIGTERM a running command is recorded as cancelled with the
    reason "Workspace command worker is stopping" and is not run again.
  - The command worker reads only `executionWorkspaces.worker.concurrency`, which is how many
    commands one process runs at once. `pollIntervalMs`, `leaseDurationMs`,
    `heartbeatIntervalMs`, `cancellationPollIntervalMs`, `staleRecoveryIntervalMs` and
    `staleRecoveryLimit` under `executionWorkspaces.worker` are still accepted and no longer
    read. After a command worker is killed, its command fails as lost within two minutes,
    and the later commands of that workspace wait until then; until now they ran at once. A
    worker that finds at a heartbeat that it lost its lease stops the process group of its
    command at once.
  - Temporary command state is removed by the schedule `workspace_command.clean_temp_state`,
    which the command worker serves. With several command workers on separate disks one tick
    cleans one host.
  - This release can run beside the previous one and be rolled back to it. A job copies its
    lease onto the lease columns of its command row, so a worker of the previous release
    leaves the row alone; the job leaves a row alone while a worker of the previous release
    holds it, and fails the command as lost when that lease runs out; and the schedule
    `workspace_command.adopt_legacy` gives every unfinished command without a job its job
    every 15 seconds, which covers commands the previous release's API queues. A job that
    waits for a worker of the previous release holds one slot of the new worker. The copy,
    the schedule and the lease columns go in a later release.
  - A job kind may name its heartbeat interval with `heartbeatMs`, below its lease; without
    it the lease is renewed every third of its length, as before.
  - `@vivd-catalyst/tool-execution` exports `createWorkspaceCommandJobs` in place of the class
    `WorkspaceCommandWorker`, and the client and the tools take a store with `transaction`.
    `ClientInstanceWorkspaceCommandWorker.worker` is a `JobWorker` and its `stop()` takes no
    argument. The command store loses `claimNextWorkspaceCommand`,
    `heartbeatWorkspaceCommand` and `recoverStaleWorkspaceCommands`; a command is claimed by
    id with `claimWorkspaceCommand`.
  - `@vivd-catalyst/capability-sdk` exports `defineJobKind` and `defineJobHandler`. The
    capability context has `jobs`, to enqueue, and `transaction`, to write a record and
    enqueue its job together. An attachment handler may implement `adoptLegacyAttachments`
    for the transition.
- **Audit (breaking, deletes data):** audit retention is enforced. The daily job `audit.prune`
  deletes the instance's audit events older than `retention.auditDays` (default 365) and
  records one `audit.pruned` event with the count. There is no switch. On the first start
  after the upgrade the first run is due at once, so every audit event older than
  `auditDays` is deleted then. Raise `retention.auditDays` (up to 3650) before upgrading if
  older events have to stay.
- **Conversation titles (breaking):** the title is generated by the job
  `conversation.generate_title`, enqueued with the first user message. The operation
  `conversations.title.generate` (`POST /api/v1/conversations/:conversationId/title`) and the API
  client's `conversations.generateTitle` are removed. A client that still calls the route gets
  a 404 and reads the title from the conversation list.
- **Chat server (breaking):** the server options `retentionExpiration` and `runRecovery` are
  removed, with `ConversationRetentionJob`, `createConversationRetentionJob`,
  `ExecutionWorkspaceCleanupJob` and the `start`/`stop`
  of `RunRecoveryWatchdog`. `createChatServerJobs(options)` returns the handlers and schedules
  for a job worker. A store implementation needs `jobs`,
  `audit.deleteAuditEventsOlderThan` and `conversations.replaceConversationTitle`. Runs that a
  process-bound runtime lost with the last process are recovered by an `agent_run.recover`
  tick that is due at every start. The generated title is written only while the conversation
  still carries the title the job read, so a rename by the user stays.

- **Platform store (breaking):** Postgres is the only platform store. The `STORE` environment
  variable is no longer read, so `STORE=memory` no longer starts an instance without a
  database; every process needs `DATABASE_URL`. Remove `STORE` from environment files. The
  `storeMode` option is gone from `createClientInstanceApp`, the worker factories, `listen` and
  the capability context, together with the `PlatformStoreMode` type, and an artifact preview
  `sourceReaderFactory` no longer receives `storeMode`. `@vivd-catalyst/core/testing` and its
  `InMemoryPlatformStore` are removed.
- **Workspaces (breaking):** workspaces are part of every instance, and the switch
  `ui.collaborationWorkspaces.enabled` is removed. Every signed-in user of the interface sees
  the workspace selector at the top of the rail, with the client branding inside it; an
  embedded token session keeps its fixed context and the branding head. Remove
  `ui.collaborationWorkspaces` from config files. For this one release a config that still
  says `enabled: true` loads; `enabled: false`, or any other value, stops the instance at
  startup with a message that names the key. That acceptance ends with the next release. The
  safe config (`GET /api/v1/instance/config`) no longer carries `features.collaborationWorkspaces`:
  deploy the interface and the API together, because an interface built before this release
  reads the new answer as invalid. Creating, browsing and requesting access to a Shared
  Workspace and adding members no longer answer 403 "Collaboration workspaces are not enabled
  for this instance".
- **Views (breaking):** a generated view loads Tailwind CSS and Lucide from the instance, in
  pinned versions under `/app-runtime/view/1/`, and no longer from two public hosts. A reverse
  proxy in front of an instance must route `/app-runtime/*` to the API. The hosts a view may
  load other scripts from are the instance key `views.allowedScriptSrc`, which defaults to
  none; before, the `show_view` tool's `config.allowedScriptSrc` defaulted to every HTTPS
  host. The `show_view` tool takes no config now: any key left there fails validation and
  names the new key. The interface composes a view's head and content policy when it shows
  the view, so the setting also governs views saved earlier: before upgrading, name every
  host saved views still need.
- **Breaking, operations:** migrations run only as an explicit step, and `RUN_MIGRATIONS` is
  gone. Each client builds `dist/migrate.js` (`client.migrate()` in `src/migrate.ts`); the
  Compose `migrate` service runs `node <client folder>/dist/migrate.js` and the API and workers
  wait for it. The API and the workers no longer migrate when they start: a database that
  lacks committed migrations stops them with the missing migration names, and a database
  ahead of the release starts. Remove `RUN_MIGRATIONS` from Compose and environment files and
  replace an inline migration command with the entry; a setup that relied on the API
  migrating at startup must run the step first. `@vivd-catalyst/postgres-store` exports
  `migrateDatabase({ databaseUrl })`, which holds the advisory lock and returns the applied
  names; the `runMigrations` option and the store's `migrate()` are removed.
- **Operations:** schema changes follow expand and contract. `pnpm check:migrations` rejects
  a changed, removed or renamed committed migration and lints every migration the base branch
  lacks against an allow list of additive forms. Any other statement, such as a drop, a
  rename, a type change, `DELETE` or a `DO` block, passes only under
  `-- contract-after: <tag>` once the oldest supported release in
  `packages/postgres-store/migration-policy.json` reached that tag; a required column without
  a default and a blocking index build never pass. A concurrent index build goes in a
  migration of its own and runs outside a transaction. `pnpm test:compatibility` runs the
  database tests of the previous and the oldest supported release against the new schema, and
  `pnpm test:upgrade` migrates a database of the oldest supported release.
- **API (breaking):** every product operation is under `/api/v1`, and no old path answers any
  more. An old path returns 404 `NOT_FOUND` "Operation is not available" with
  `details.reason: "unknown_operation"`; the one exception is the old API-key exchange below.
  A caller changes the path of every request. `/api/conversations…`
  becomes `/api/v1/conversations…`, `/api/collaboration-workspaces…` becomes
  `/api/v1/workspaces…`, `/api/approval-requests…` becomes `/api/v1/approval-requests…`,
  `/api/me…` becomes `/api/v1/me…`, and `/api/password-reset` and `/api/password-setup` gain the
  prefix. Paths carry no role name: `/api/admin/config/…` becomes `/api/v1/instance/config/…`,
  `/api/admin/collaboration-workspaces` becomes `/api/v1/instance/workspaces`,
  `/api/superadmin/users…` becomes `/api/v1/instance/users…`, `/api/superadmin/usage` becomes
  `/api/v1/instance/usage`, `/api/superadmin/api-access/service-principals…` becomes
  `/api/v1/instance/service-principals…`, `/api/superadmin/api-access/credentials/:id/revoke`
  becomes `/api/v1/instance/api-credentials/:id/revoke`, `/api/audit-events` and
  `/api/audit-activities` move to `/api/v1/instance/…`, and `/api/config` and `/api/branding`
  become `/api/v1/instance/config` and `/api/v1/instance/branding`. Rights are unchanged.
  `/health` stays public and unversioned, and `/api/auth/*` stays the sign-in library's mount.
  A reverse proxy that forwards `/api/*` needs no change.
- **Interface:** reload every open tab after the upgrade. A tab loaded before it calls the old
  paths and shows "Operation is not available" with no hint; this release cannot change that
  page. From this release on, the interface shows one notice with a reload action when the
  server answers that it does not know an operation the interface called.
- **API (breaking):** the API-key exchange moved from `POST /api/auth/access-token` to
  `POST /api/v1/auth/access-token`. Session-token issuance for embedding hosts moved from
  `POST /api/superadmin/session-tokens` to `POST /api/v1/instance/session-tokens`, and its
  alias `POST /auth/session-token` is removed. An older CLI, which sends its key as a bearer
  to the old exchange path, reads 401 `UNAUTHENTICATED` "Standalone auth endpoints do not
  accept explicit credential headers" on an instance with standalone sign-in, because the
  sign-in mount refuses the header before it routes, and 404 elsewhere. A backend that issues chat session tokens
  changes its URL; the `x-server-credential` header and the payload are unchanged. Before this
  release is deployed, search the production access log for both old token paths and move any
  caller found.
- **API (breaking):** operation ids are `<resource>.<verb>`, for example `conversations.list`,
  `workspaces.members.add` and `me.get`, in the OpenAPI document and in `apiOperations`. Code
  that read `apiOperations.listConversations` reads `apiOperations["conversations.list"]`.
  The development mail listing moved to `GET /api/v1/dev/captured-mail` and stays out of the
  document, as does `/health`.
- **CLI (breaking):** `catalyst config` signs in with `CATALYST_API_KEY` only. The fallback to
  `CATALYST_SERVER_CREDENTIAL` and `CHAT_SERVER_CREDENTIAL` and its deprecation warning are
  removed; without a key the CLI stops before it sends a request. Create a service principal
  and a key under Administration → API Access and set `CATALYST_API_KEY` wherever the CLI runs.
  The server needs `SERVICE_ACCESS_TOKEN_SECRET` set, at least 32 characters; without it the
  instance has no API access and the CLI cannot sign in. For a local development instance,
  `catalyst config local-key` creates the principal and key as the seeded superadmin and
  writes the key into `.env`; it refuses any other host. CLI and server ship together: this
  CLI needs a server that answers under `/api/v1`.
- **Client:** `getAuthSession`, `signInWithEmail` and `signOut` are exported from
  `@vivd-catalyst/api-client`; the interface no longer fetches `/api/auth/*` itself.
- **Client (breaking):** the methods of `createApiClient` are derived from the operation
  catalog instead of written by hand or generated. Every operation is one method under the
  segments of its id, and takes one object with the parts its descriptor names:
  `client.conversations.thread.get({ params: { conversationId } })`,
  `client.conversations.list({ query: { collaborationWorkspaceId } })`,
  `client.users.create({ body })`, each with an optional `signal`. The old names are gone, for
  example `client.account.get()` is `client.me.get()`, `client.runs.start(id, input)` is
  `client.conversations.runs.start({ params, body })` and `client.configAssets.export()` is
  `client.config_assets.export()`. A list method answers one page, `{ items, nextCursor }`;
  `listAll((paging) => client.users.list({ query: paging }))` reads a list to its end. A
  stream is an async iterable, resumed with `query: { after }`. A file URL for the browser
  comes from `client.urlFor(operationId, { params, query })`. A success that is not valid JSON
  or does not match the response schema is now an `ApiError` with the response status and the
  parse failure as `payload`, where a schema mismatch was a `ZodError` before; an abort
  through the caller's `signal` rejects with the abort itself, never an `ApiError`; a stream
  that breaks off is an `ApiError` of status 0. The package no longer contains generated code
  and no longer depends on `@hey-api/openapi-ts`; its `generate` script is removed. The
  OpenAPI document of `@vivd-catalyst/api-contract` is unchanged.
- **API (breaking):** every list answers with `{ items, nextCursor }` instead of a bare array.
  `limit` defaults to 50 and accepts 1 to 200, anything else answers 422. `nextCursor` is
  absent on the last page; pass it back as `cursor` with the same filters to read the next
  page. A cursor from another list or with other filters answers 422. The conversation
  resources list carries `items` instead of `resources`, and the agents of a workspace carry
  `items` instead of `agents`, next to `defaultAgentName`. Workspaces in the directory and in
  the administration picker carry `createdAt`, the key they are paged by. The audit
  activity view is not paged: it answers `{ items }` with the latest activities only, at most
  100 from the latest 500 audit events, and takes no `limit` or `cursor`. The shared API
  client keeps returning complete arrays; its audit event helper returns the latest 100
  events.
- **API (breaking):** every timestamp is UTC and ends in `Z`. A timestamp with an offset such
  as `+02:00`, or without a zone, answers 422; this applies to `expiresAt` when an API
  credential is created.
- **API (breaking):** reading no longer creates anything. A list of workspaces or
  conversations does not create the caller's Personal Workspace; call
  `POST /api/v1/workspaces/personal` once instead. A preview read does not start
  the preview; call `POST /api/v1/conversations/{conversationId}/artifacts/{artifactId}/preview`
  or `POST /api/v1/conversations/{conversationId}/attachments/{attachmentId}/preview`, and read
  the preview until it is ready. A preview that was never started reads as `pending` without
  `queuedAt`. The three operations need the scope of the read they replace.
- **API (breaking):** every error answers with
  `{ error: { code, message, correlationId, details? } }`, and the same id in the
  `x-correlation-id` response header. A caller's own `x-correlation-id` request header is
  kept. An unknown path answers 404 in this shape. `RATE_LIMITED` (429) is a new code. An
  `INTERNAL` error always reads "Internal server error".
- **Document worker (breaking):** the worker answers errors in the same envelope,
  `{ error: { code, message, correlationId } }`, instead of the flat `{ code, message }`.
  Deploy the worker and the application of one release together.
- **Chat:** after a restart, an instance that runs agents in its own process ends the runs the
  last process left open, so their conversations accept new messages at once.
- **Chat:** the conversation list is a compact single-line list without the last-updated date.
  A conversation within seven days of its retention date carries an amber clock, on instances
  with `retention.expireConversations` enabled. Its hint names the deletion date; it opens on
  hover and on keyboard focus, and the row's menu repeats it for touch.
- **Administration:** saving an agent or skill confirms it next to the save button until the
  form is edited again.
- **Chat:** the start page introduces the agent with its icon and name, centred above the
  composer: several agents make the name a picker that opens on click, a single agent a plain
  label. In a conversation the header shows the icon alone, and pointing at it opens the agent
  list, with a single agent too. `ui.showAgentName` is now `true` by default, decides
  only whether the start page shows the name beside the icon, and no longer adds the client
  name beneath the agent; with `ui.showAgentName: false` the start page shows the icon alone
  as well.
- **Chat:** the agent list shows each agent's description only with the new
  `ui.showAgentDescriptions: true`; by default it lists the names alone.
- **Approvals:** the review queue behind the clipboard icon in the sidebar's footer is gone;
  `/approvals` leads to `/inbox`. The card of a request in a conversation opens the same item
  beside the chat. Rejecting from the item takes an optional comment. A collapsed sidebar shows
  the number of an item's count on its icon.

### Fixed

- **Models:** a caller that stops reading a streamed answer without stopping the call now ends
  the request to the provider, for every adapter. Before, the provider kept generating, and
  billing, after the call was settled.

- **Chat:** a list or menu opened right after a conversation stays open. The composer tried
  for the focus once more 50 milliseconds after a conversation was opened, and took it out of
  an agent list opened in that time, which closed the list. The composer now stops trying once
  a pointer or a key is pressed.

- **Chat:** an answer that has just finished gets its work history, its actions and the next
  turn without a reload. An instance that runs its agents in the API process announced the end
  of a run before its stores had recorded it, so a page that read the conversation back at that
  moment was told the run was still going and kept showing the answer as unfinished. The end
  of a run is now announced once it is recorded.
- **Audit:** the audit event for the end of a run (`message.completed`, `message.failed`,
  `message.cancelled`) is written before the run's event stream announces that end. It was
  written beside the stream, so a reader of the audit right after the end could miss it.
- **Conversation rail:** the retention clock of a conversation with a long title can be reached
  with the pointer. The clock stood at the end of the row under the row's menu button, unseen
  until the row is hovered, and moved aside when the button appeared. A row with a clock now
  keeps the room for its menu button, so the clock stays where it is. `NavItem` takes
  `trailingKeepsRoom` for this.
- **Chat:** a conversation opened while another one is answering shows only its own messages.
  Until its thread arrives it is empty, where it used to show the messages and the partial
  answer of the conversation left behind, and the page no longer asks for that conversation's
  run under the address of the one opened.
- **Chat:** an instance configuration that does not load no longer leaves "Loading
  configuration" standing. A request without an answer or with a 5xx is tried three more times;
  after that, or at once for an answer of a shape the interface cannot read, a panel offers "Try
  again" and "Reload". An answer from another release reads as the outdated-tab notice does, and
  the console names the paths of the fields that did not fit, never their values. The client
  reports an answer that does not match its operation's schema as `ApiResponseShapeError`, an
  `ApiError` with those paths, and calls `onResponseMismatch`; the interface then shows the
  reload notice, also for an enum value or a stream event of a later release.
- **Models:** a long conversation no longer fails on every message after the provider compacted
  its context into an item above the provider's limit of 20,971,520 characters per string. Such
  an item, and an encrypted reasoning item of that size, is not kept. A stored one, or one the provider refuses with 400
  `string_above_max_length` on `encrypted_content`, is dropped and the request is sent once more
  from the conversation's history, so affected conversations answer again without a migration.
  A provider's 400 `context_length_exceeded` fails the run with "This conversation is too long
  for the model. Start a new conversation." instead of an internal error.
- **Models:** an image whose data URL would exceed the same limit (about 15 MiB of image bytes) is
  left out of the request to an OpenAI-compatible provider, and the model reads a note in its
  place that an image was too large to include. Such an image used to fail the run with 400
  `string_above_max_length` on every message of the conversation.
- **Models:** images a tool loaded for the model, such as rendered document pages, are sent only
  during the run that loaded them. In later runs the tool result names what each image showed
  (file, page, slide, sheet or range) and the model repeats the tool call to see it again. Every
  request used to carry every such image of the conversation again, which made requests of tens
  of megabytes and provider compaction items above the provider's string limit. Images a user
  attached to a message are still sent in later runs. One request carries at most 32 MiB of image
  bytes (`MODEL_INPUT_IMAGES_MAX_BYTES`); above that the oldest images are named instead of sent.
- **Models:** the image of a page, slide or sheet that the model reads is a rendition of its
  own: JPEG at quality 80 with a long edge of at most 1568 pixels
  (`MODEL_PAGE_IMAGE_MAX_LONG_EDGE_PIXELS`), 0.06 to 0.45 MB a page. The preview worker renders
  it beside each preview page and `workspace.preview_images` gives it to the model; the PNG a
  person sees in a preview is unchanged. The model used to be given that PNG, which the
  renderer scales to 4096 pixels: 0.9 MB for a text page and 17 MB for a colour scan. A preview
  rendered before this release has no such rendition, and the model is given its PNG, counted
  at its real size against the image budget. The artifact preview worker must run this release
  for new previews to carry the rendition.
- **Models:** a run waits out a provider's per-minute rate limit. On HTTP 429, or the same
  refusal inside a stream, a model call waits about 4 s, 8 s, 16 s and 32 s, up to 60 s in
  total, and never sooner than the provider's `Retry-After`; a `Retry-After` beyond what is
  left of the 60 s fails the run at once. As before, this applies only while nothing of the
  answer was shown, and no wait starts past the run's deadline or continues after a cancel. A
  run that still fails on a rate limit reads "The model is receiving too many requests. Try
  again in a minute." with code `RATE_LIMITED` instead of an internal error.
- **Retention:** conversation expiry decides under the conversation's row lock and removes
  data only afterwards. A conversation is expired only if it is still due, or still an
  abandoned draft, at that moment, so a message, an upload or a restored draft attachment that
  arrives while the job runs keeps the conversation and its files. A due conversation with an
  agent run in progress is left for the next run of the job. Deleting a conversation follows
  the same order. When removing stored objects fails, the conversation stays expired or
  deleted, the failure is audited as `conversation.cleanup_failed`, and the retention job
  retries the cleanup on each run and audits `conversation.cleanup_completed` when it is done.
  `conversation.retention_expired` and `conversation.deleted` carry `cleanup: "complete"` or
  `"pending"`. The first retention run after the update also cleans what earlier deleted or
  expired conversations left behind when their cleanup had failed.
- **Workspaces, accounts:** deleting a Shared Workspace, an account or a user answers 409 with
  `details.pendingCleanupCount` while data of its deleted conversations is still being
  removed, and removes nothing further. The conversations are deleted at that point. The
  request completes when it is repeated after the retention job has finished the cleanup. A
  refused account deletion leaves the user with every membership and access request. The
  refusal is audited as `collaboration_workspace.delete_failed` or `user.delete_failed`. The
  retention job now retries pending cleanups before it expires conversations. When only
  execution workspace data of a deleted conversation is left, the workspace cleanup job
  finishes it, not the retention job. No time is promised for the repeat: it succeeds once
  the jobs have run and found nothing left. Both deletions take the workspace row lock first,
  so a conversation that is created in the workspace or moved into it at the same moment
  fails instead of being removed with it.
- **Conversations:** an artifact, a workspace file or a message is written only into an active
  conversation and under the conversation's row lock. A write that arrives after the
  conversation was deleted or expired is refused with `NOT_FOUND`; the writer removes the
  bytes it had already stored, best effort, and logs a failed removal with the object key. An
  agent run or a workspace command that is still working when its conversation is deleted
  fails at its next such write.
- **Attachments:** in an instance without a capability attachment handler, deleting a
  conversation now removes every object its records name, preview images under
  `artifact-previews/` included. Before, those images stayed in storage while their records
  were marked deleted. Images left behind by earlier versions are not removed by this
  release.
- **Audit:** `conversation.cleanup_failed` and `conversation.cleanup_completed` appear in the
  governance tier, and the four new event types have labels in the activity view.
- **Migrations:** two migration steps that start at once no longer deadlock on a migration
  that builds an index concurrently. The step asks for its lock again every 100 ms instead of
  waiting inside one statement.
- **Migrations:** a migration step whose database connection the server ended names the
  migration and the cause (`Migration <name> failed: the database connection ended (…)`) and
  exits, instead of dying with a `TypeError` of the driver or not ending at all. A step that
  waits for another step's lock says so when it starts to wait and every 30 seconds after.
- **Inbox:** the open item asks for its state every 60 seconds and whenever a list shows it
  changed, so it no longer offers a decision on a request someone else has decided. A decision
  that still comes too late is answered in one sentence that names who decided, and a comment
  already written stays on the page.

## 0.6.3 — 2026-10-08

### Fixed

- **Chat:** a file is read before its upload request opens, and an upload that fails without an
  answer from the API is retried. A browser that could not read a file promptly used to stall
  the request until the reverse proxy gave up. The remaining error names the file.
- **Models:** a provider `server_error` or `rate_limit_exceeded` inside a Responses stream is
  retried like the same failure on the request. A stream that stays silent for 10 minutes is
  given up as a timeout instead of holding the run until the provider answers.

## 0.6.2 — 2026-10-08

### Changed

- **Chat:** a long user message is collapsed to a few lines with "Show more" and "Show less".

## 0.6.1 — 2026-10-08

### Changed

- **Skill change proposals:** a proposal for a new skill can carry its supporting files in the
  same request: `create_skill` first, followed by `create_resource` operations such as
  `references/checklist.md`. The limit per operation text is 20,000 characters instead of 4,000.

## 0.6.0 — 2026-10-06

### Added

- **Deployment kit:** the release and deploy tooling of operated instances is the package
  `@vivd-catalyst/deployment-kit` with the command `catalyst-deploy` (`check`, `update-refs`,
  `prepare-workspace`, `publish`, `manifest`, `deploy`). It carries what each deployment repo
  kept as its own copy: the deploy by image digest, release manifests, staging and production
  publishing, Postgres backup and restore with their systemd units, the zram setup, and the
  checks of the worker wiring in Compose. A deployment names its instance in
  `deploy/deployment.env` (`INSTANCE`, `IMAGE_REPOSITORY`, `APP_PACKAGE`,
  `EXECUTION_WORKSPACES`); host paths, dump names and unit names follow from it. The package is
  not published yet and is used from the platform checkout at the pinned ref.

### Changed

- **Deployment kit:** the scripts under `scripts/deployment-kit/` moved into the package. The
  old paths remain as forwarding stubs, so deployments pinned to them keep working.
- **Release check:** `check-release.sh` no longer requires a `deploy/scripts` directory in the
  deployment.

## 0.5.1 — 2026-10-06

### Added

- **Retention:** the hourly retention job removes orphaned managed files. A `managed_files` row
  older than 24 hours that no active conversation refers to, through an attachment of any
  status or as the source of an artifact, is marked deleted and its stored object is removed.
  This reaches what user deletions before 2026-08-31 and interrupted uploads left behind. The
  job records one `storage.orphaned_files_deleted` audit event with counts per run that removed
  something. An attachment handler takes part by implementing the optional
  `deleteOrphanedFileObjects`; without it nothing is removed.

### Fixed

- **Admin pages:** a table taller than the window, such as the user list, scrolls again instead
  of being cut off.
- **show_view:** the layout guidance for views closes two padding loopholes.
- **Conversation rail:** the collapse handle on the rail's edge no longer covers the list's
  scrollbar. It appears while the pointer is on the rail's right border or the handle has
  keyboard focus.
- **Uploads into a deleted conversation:** a draft attachment whose conversation is deleted
  while the file is still arriving is rejected before any bytes are stored. The conversation
  was checked only when the request started, so a slow upload could leave a stored object and
  a `managed_files` row that no deletion would reach.

## 0.5.0 — 2026-10-06

### Added

- **Retention:** `retention.expireConversations: false` lets a client instance keep
  conversations indefinitely.

### Changed

- **Packaging:** the library packages carry publish metadata for npm (`files`, typed `exports`
  without the `development` condition, restricted access, licence, `engines`) and are no longer
  marked `private`. `pnpm release:check` builds, packs and inspects every tarball and installs a
  consumer set outside the workspace; `pnpm release:metadata` reapplies the shared fields.
  Nothing is published yet.
- **chat-ui:** `tailwindcss` and `tw-animate-css` are peer dependencies. The stylesheet no longer
  scans `chat-standalone`, which has its own stylesheet now, and finds Streamdown's classes when
  installed from a tarball as well as in the workspace.

### Fixed

- **Abandoned draft conversations:** attaching files on the start page and removing them again
  no longer leaves an empty conversation in the rail. `GET /api/conversations` lists a
  conversation without messages only to its creator, and only while it holds draft attachments;
  access by id is unchanged. Removing the last draft attachment returns the composer to the
  start page, and the retention job expires conversations that have had neither messages nor
  draft attachments for 24 hours. This cleanup also runs with
  `retention.expireConversations: false`, which keeps every conversation that has a message or
  a draft attachment.
- The `catalyst` CLI did nothing when started through the `node_modules/.bin` link of an
  installed package.

## 0.4.0 — 2026-10-06

### Changed

- **Agent model settings:** an agent may offer its users any model binding agents may use. The
  binding-level `userSelectable` key in release config is still accepted but no longer has an
  effect; `agent_models.manage` governs the choice. The agent editor shows one model list with
  a default and a "Selectable by users" tick per model.
- **Reasoning effort per model:** `modelReasoningEfforts` sets the effort for each model an
  agent offers to users, edited per row in the model list. `reasoningEffort` stays the effort
  of the agent's own model and is no longer applied to a model a user picked instead, which
  now runs with its own entry or the binding's default.
- **API:** the safe config view no longer carries the top-level `selectableModels`; use
  `agents[].selectableModels`. The config assets overview no longer carries
  `references.userSelectableModelBindings`.

## 0.3.0 — 2026-10-06

### Changed

- **Agent model settings:** each agent lists the models chat users may pick in
  `userSelectableModelBindingIds`, editable with `agent_models.manage`. The composer offers the
  agent's own model plus that list instead of every `userSelectable` binding, so a deployment
  that offered a model choice must add the list to its agents to keep it. The safe config view
  carries `agents[].selectableModels`.

### Fixed

- Saving an agent's model settings no longer fails with 403 when its other fields are locked:
  unchanged fields were reported as changed because stored JSON key order differs.
- A rejected save shows the server's message next to the save button.
- Viewers of a shared conversation can no longer interrupt another user's active run.

## 0.2.0 — 2026-10-06

First versioned release. Compared with production, which runs `staging-2026.09.14-1` (platform
`a2a13a8`, deployed 2026-09-14):

### Added

- **Email:** transactional mail with password reset and user invitations.
- **Approvals:** agents propose skill changes; reviewers approve, reject or request changes on an
  approvals page with an open queue and a collapsed history. Decisions appear in the conversation.
  Release-configured checks fail closed. A reviewer revises someone else's proposal in their own
  conversation.
- **Conversation visibility:** private conversations in Shared Workspaces, with a default per
  workspace.
- **Agent availability:** agents can be limited to selected Collaboration Workspaces.
- **Start page:** centred composer with starter prompts and agent cards.
- **Agent model settings:** model, reasoning effort and fast mode per agent behind the
  `agent_models.manage` permission; fast runs are settled by the tier the provider reports.
- **Operations:** the agent-run worker drains active runs on shutdown; the config CLI detects
  conflicts per asset and lists agents left hidden after a push.

### Fixed

- Workspace conversations stay in the rail on settings, approvals and admin pages.
- User messages with wide code blocks stay inside the thread; code and quotes are readable in
  user message bubbles.
- Forwarding headers are trusted from private proxy peers.
- Emailed password setup completes in one transaction and rejects invalid tokens early.

### Database

Migrations 0025 to 0029. 0027 backfills existing conversations as visible to the workspace; 0028
backfills existing agents as available everywhere.
