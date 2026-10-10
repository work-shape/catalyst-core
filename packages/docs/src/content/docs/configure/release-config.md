---
title: Release Config
description: Use source-controlled config as the source of truth for instance behavior.
---

Static release config defines the code-deployed ceiling of a client instance. It is version-controlled, validated at startup, and deployed with the client assembly app.

Agents and client skills are separate versioned configuration assets. The Catalyst CLI synchronizes their complete YAML and Markdown working copies with the active instance. Static release config decides which of their fields and operations are additionally editable through interactive administration.

## What Release Config Owns

Release config should cover:

- tool enablement and tool parameters
- model providers and approved model bindings
- which optional features run, as [modules](/configure/modules/)
- capability settings
- interactive agent-configuration policy
- supported locales and default locale
- client branding and theme
- welcome copy, placeholders, and suggested prompts
- retention and deletion policy
- audit retention
- usage budgets and safeguards
- OpenAPI operation selections
- built-in tool enablement

## Example

```yaml
version: 1
clientInstance:
  id: example-support
  displayName: Example Support Chat

modules:
  assetManagement:
    enabled: true

administration:
  agentConfiguration:
    editableAgentFields:
      - displayName
      - welcomeMessage
      - modelBindingId
      - reasoningEffort
      - initialPrompts
    allowAgentCreation: false
    allowAgentDeletion: false
    allowDefaultAgentChange: false
    allowSkillEditing: false

ui:
  clientName: Example Company
  faviconUrl: /favicon.svg
  defaultLocale: en
  supportedLocales: [en, de]
  welcomeMessage:
    en: How can I help with your support case?
    de: Wie kann ich bei deinem Supportfall helfen?
  theme:
    accentColor: "#0f766e"
    backgroundColor: "#f7f7f4"
    surfaceColor: "#ffffff"

retention:
  conversationDays: 90
  expireConversations: true
  extendOnActivity: true
  auditDays: 730
  allowUserDelete: true

usage:
  budget:
    dailySpendLimit: 50
    monthlySpendLimit: 400
    costSafetyMultiplier: 1.3
  safeguards:
    modelCallsPerDay: 1000
    tokensPerDay: 2500000
  costs:
    customer:
      id: example-customer
      version: "2026-07"
      currency: EUR
      models:
        - providerId: openai
          model: gpt-5.5
          uncachedInputPricePerMillionTokens: 5
          cachedInputPricePerMillionTokens: 0.5
          outputPricePerMillionTokens: 30
```

### Retention

| Key                             | Default | Meaning                                                                                                                                        |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention.conversationDays`    | `30`    | How long a Conversation is kept, in days.                                                                                                      |
| `retention.expireConversations` | `true`  | `false` keeps every Conversation a user started, whatever its date. Abandoned drafts are still removed.                                        |
| `retention.extendOnActivity`    | `true`  | `true` counts `conversationDays` from the last message a user sent. `false` counts from the creation of the Conversation: a fixed maximum age. |
| `retention.auditDays`           | `365`   | How long audit events are kept.                                                                                                                |
| `retention.allowUserDelete`     | `true`  | Lets users delete their own Conversations.                                                                                                     |

With `extendOnActivity: true`, every message a user sends moves the deletion date to `conversationDays` after that message, and never to an earlier date. Opening, reading, renaming or moving a Conversation, the generated title and background jobs do not move it. A Conversation someone keeps writing in is therefore never deleted for age. Set `extendOnActivity: false` when the instance has promised a maximum age: the date set at creation then stands, whatever is written later.

Changing `conversationDays` or `extendOnActivity` does not rewrite the dates of existing Conversations. A Conversation takes the new period with its next message, when `extendOnActivity` is on.

In its last seven days, or the last half of a period shorter than fourteen days, a Conversation carries a clock in the list, and the open Conversation shows one line above the message field with the deletion date. With `extendOnActivity: true` the line adds that a new message keeps the Conversation.

The conversation Resources panel appears only after a user enters a persisted Conversation. It is the module `resources`; turn it off with `modules.resources.enabled: false` when a deployment must opt out of that surface. [Modules](/configure/modules/) lists every optional feature and its switch.

Daily and monthly spend limits use `usage.costs.customer.currency`. Set it to the invoice currency and express every configured model and web-search price in that same currency.

`costSafetyMultiplier` is a private enforcement buffer. Budget checks multiply the persisted customer billable total by this value, while stored usage records and customer-facing billable costs remain unchanged. It defaults to `1`.

The customer rate card uses exact `providerId` and `model` rows and prices uncached and cached input separately. Its `version` must change when any rate changes. Usage Governance persists the applied rates and billable amount with every new usage event, so changing the active card affects only future usage.

A model row may carry a `fast` block with the same three prices for fast-mode calls:

```yaml
usage:
  costs:
    customer:
      models:
        - providerId: openai
          model: gpt-5.5
          uncachedInputPricePerMillionTokens: 5
          cachedInputPricePerMillionTokens: 0.5
          outputPricePerMillionTokens: 30
          fast:
            uncachedInputPricePerMillionTokens: 10
            cachedInputPricePerMillionTokens: 1
            outputPricePerMillionTokens: 60
```

Every model binding with `supportsFastMode: true` needs these rates; startup validation fails without them. The usage event records both that the call was requested in fast mode and the service tier the provider reported. A fast request is settled with the `fast` rates unless the provider explicitly reported another tier, for example `default` after a downgrade to standard processing; then it is settled with the normal rates. When the provider reports no tier, the `fast` rates apply. The usage view marks a call as fast only when it was billed that way. Adding or changing fast rates is a rate change and needs a new card `version`; earlier usage is not re-rated.

## Approval checks

`approvalChecks` defines model-evaluated rules for proposed approval requests. It defaults to an empty list. Each check needs a unique id, a registered request kind, and an existing model binding. Instructions may be written in any language.

```yaml
approvalChecks:
  - id: no_personal_data
    appliesTo: skill_change
    modelBindingId: guardrailCheck
    instruction: Check whether the proposed content contains personal data.
    onFail: warn
```

Checks run concurrently when a request is created. For skill changes, the summary and proposed new text are sent to the configured model provider; existing skill text and replaced text are excluded. Select a provider and binding approved for that content. Each check is a model call of the instance: it counts toward the usage budgets and safeguards and leaves one usage record with the purpose `guardrail_judge`, also when it fails or times out. The record names the originating conversation when there is one and never an agent run.

`warn` stores a visible warning and leaves the decision with the approver. `block` refuses a violating proposal and returns the reason to the agent without storing a request. If a check cannot be evaluated, including provider failures or the 60-second timeout, `warn` stores a neutral warning and `block` refuses the proposal, so a blocking rule never lets unchecked content through. When a usage limit of the instance refuses the check, the reason given to the agent says that the limit is reached. Checks are not repeated when a request is decided. Request kinds without a proposed-content extractor are not checked.

Creation audit metadata contains only check ids and statuses, never proposed content or reasons. Stored check messages remain part of the approval request.

## Sharing Config Across Environments With `extends`

A config file can start from another config file and override only what differs:

```yaml
# app.staging.yaml
extends: ./app.base.yaml
clientInstance:
  id: example-staging
  environment: staging
auth:
  standalone:
    baseUrl: https://staging.example.test/api/auth
```

Merge rules:

- Objects merge recursively; the extending file wins on conflicts.
- Arrays and scalars replace the base value wholesale — overriding one list entry means restating the whole list.
- `extends` chains are allowed; cycles fail validation with a clear error.
- Relative paths in the merged result (such as `uiFile`) resolve against the entry file's directory, not the extended file's.
- When a merged config has both `uiFile` and inline `ui`, the file supplies the base UI config and inline `ui` overlays it with the same object and array merge rules.

Keep everything shared in one base file and put only genuine per-environment differences in the environment files. Reading an environment file should answer "what makes this environment different?" at a glance.

## Tool Configuration

Each tool entry controls whether a stable tool name is available in the client instance. The optional `config` object is passed to the matching configured tool factory and validated by that factory's schema during startup.

```yaml
tools:
  - name: support.lookup_ticket
    enabled: true
    config:
      permissionRef: support-ticket-reader
      endpointEnvName: SUPPORT_API_URL
  - name: support.create_escalation
    enabled: false
```

Use `config` for customer-specific values such as permission references, default currencies, endpoint names, model-facing labels, allowlists, and secret environment variable names.

Do not put secret values in `config`. Put secret values in environment files or a secret manager, and reference them by name.

Startup validation fails when:

- an enabled tool has no registered implementation
- a configured tool's `config` does not match its schema
- an agent references a disabled or missing tool
- an enabled tool requires approval before approval resume is implemented

## Web Access

`webAccess` holds the instance switches for reaching the web. Everything is off by default.

```yaml
webAccess:
  enabled: true
  search:
    enabled: true
  fetch:
    enabled: true
```

- `webAccess.enabled` is the gate for both search and fetch.
- `webAccess.search.enabled` lets agents that list the tool `web_search` search the web. The
  search is the model provider's own: whether a model can search is declared by its provider,
  not set in config. An `openai-compatible` entry with `api: responses` can; an entry on
  `chat_completions` and the `deterministic` provider cannot. An agent whose model cannot
  search runs without the tool, and saving that agent is refused with "the model of this agent
  cannot search the web". There is no search provider run by the platform.
- `webAccess.fetch` enables the `web_fetch` tool and bounds what one fetch may read.

`webAccess.search.mode` and `webAccess.search.managedProvider` were removed. A config that
still sets either is refused at startup with one message naming every such key; delete them.

An agent with `web_search` also needs a customer price for web search calls of its provider
under `usage.costs.customer.webSearch`.

## Generated Views

A view an agent shows with `show_view` loads Tailwind CSS and Lucide from the instance and no script from any other host. `views.allowedScriptSrc` names the hosts views may load scripts from besides the instance, as HTTPS origins or paths:

```yaml
views:
  allowedScriptSrc:
    - https://cdn.jsdelivr.net
```

The default is an empty list, and `"*"` allows every HTTPS host. The setting applies when a view is shown, so it also governs views saved before a change. Earlier releases read script settings from the `show_view` tool's own `config`. That tool takes no config now, and any key left there fails validation with a message that names `views.allowedScriptSrc`.

### What A View Can Reach

A view cannot by itself load from, move its frame to or send HTTP or WebSocket requests to a host the instance has not allowed. A view that holds private rows also carries no address a person could open from it.

Three things hold this.

- **The view's content policy.** The interface composes it each time it shows the view. It refuses every load and every connection except scripts from the instance's view runtime and from the hosts in `views.allowedScriptSrc`.
- **The shell.** Every view is framed in a small document the instance serves under `/app-runtime/view-shell/<version>/`, whose `Content-Security-Policy` header carries `frame-src 'none'`. A view that sets `location`, carries a refresh tag or has a script follow a link would move its own frame to another address, and no policy of the view itself can forbid that. The browser checks the move against the policy of the framing document and refuses it before it sends a request, to addresses of the instance as well. Because the policy is a header of the instance, it also holds when another site embeds the chat widget.
- **The allowlist for views with private rows.** A view of kind `private_hydrated_view` runs no script, and its rows are written into its HTML on the server. Such a view needs no script to send rows away: a link carries them in its address, and a click with a modifier key or the middle button opens it in a new tab, outside the frame. So the interface does not show the stored HTML of such a view. It reads it with the browser's parser and writes the body anew from a list of allowed elements and attributes, each time the view is shown. Row text is already part of the stored HTML at that point, so whatever it became is held to the same list.

What a view with private rows keeps:

| Kept | With |
| --- | --- |
| Text, headings, paragraphs, sections, `pre`, `blockquote`, `details` | `class`, `id`, `style`, `title`, `lang`, `dir`, `role`, `hidden`, `aria-*`, `data-*` |
| Lists and tables | also `colspan`, `rowspan`, `headers`, `scope`, `span`, `start`, `value` |
| Inline formatting, `time`, `meter`, `progress` | their value attributes |
| `a` | its text, never an address |
| `img` | `alt`, `width`, `height`, and `src` only when it starts with `data:` or `blob:` |
| `style` blocks and `style` attributes | only without `url(` other than `url(#id)`, `@import`, `image-set(`, `image(`, `src(` or a backslash |
| Inline `svg` with shapes, `text`, gradients and clip paths | geometry and paint attributes, no `href` |

Everything else is left out with what is inside it: `script`, `link`, `meta`, `base`, `area`, `form` and its controls, `iframe`, `object`, `embed`, `canvas`, `video`, `audio`, SVG `a`, `image`, `use` and `foreignObject`, every event handler attribute, `href`, `ping`, `target`, `srcset` and `srcdoc`.

The limits:

- **WebRTC.** A view that runs scripts can send UDP packets to a host its script names. No content policy and no sandbox flag of current browsers forbids WebRTC. The view's bootstrap removes `RTCPeerConnection` and its prefixed variants from the view's window. That is hardening and not a boundary: a script gets the constructor back in a frame it writes itself.
- **Links in a view that runs scripts.** The view's bootstrap takes the address from every link, image map area and SVG link, and cancels a click on one that still has an address. That is hardening and not a boundary: a script can put a link back where the bootstrap does not run, in a frame it writes itself, and a click on it with a modifier key or the middle button then opens the address in a new tab. Opening a link from the context menu and dragging a link out of a view have not been tested.
- **A static view is static.** A view with private rows shows HTML and CSS. A chart drawn by a script on a canvas does not appear, and the frame keeps a fixed height and scrolls inside, since nothing in it can report its height.
- **DNS.** Whether a view can cause a DNS lookup for a host of its choosing has not been observed. A view with private rows keeps no `link` or `meta` element, so it carries no resource hint. For a view that runs scripts this is open.
- **Allowed script hosts are data destinations.** A host named in `views.allowedScriptSrc` receives the requests a view makes for its scripts, and a view chooses the address, so data can leave in it. Name only hosts you would send the data to.
- **A view navigates nowhere.** A link in a view has no address, `#fragment` included, and a view that moves its frame anyway shows the browser's own notice for a refused address.
- **Sites that embed the widget.** The shell is a frame from the instance. A site that embeds the chat widget under a content policy of its own must allow the instance's origin in `frame-src`, or no view is shown there.
- **Browsers.** All of this is tested in Chromium only. Firefox and Safari are untested. The shell relies on the browser applying `frame-src` of the framing document to a navigation of the frame, and on a `srcdoc` frame taking over the policies of the document that holds it.

The shell answers only requests a browser makes for a frame: a request whose `Sec-Fetch-Dest` header names anything else gets `403`. The shell runs under `sandbox`, so it and the view have an opaque origin and neither can read anything of the instance. The requests for the shell and for script files are still requests to the instance, and a browser may attach eligible cookies to them. The routes read none. A reverse proxy in front of the instance must route `/app-runtime/*` to the API. When it does not, views stay on "Loading view…".

## Agent And Skill Configuration Assets

Agents and client skills remain source-controlled YAML and Markdown, but runtime reads them from the versioned configuration-asset store. A `catalyst.yaml` manifest selects the working-copy files and target instances:

```yaml
instances:
  staging:
    url: https://catalyst.example.test
defaultInstance: staging
defaultAgentName: support_agent
agents:
  - agents/*.agent.yaml
skills:
  - skills/*/SKILL.md
```

Use `catalyst config pull`, `diff`, `validate`, and `push` to synchronize the complete entities. Push uses the last pulled version and conflicts when the active instance changed in the meantime. The CLI release path has full entity access; ordinary administration writes are limited by `administration.agentConfiguration` and enforced by the server.

An agent YAML file contains its behavior and grants:

```yaml
name: support_agent
displayName: Support Agent
instructions: Help users with support cases.
modelBindingId: primary
reasoningEffort: medium
toolNames:
  - read_skill
  - support.lookup_ticket
skillNames:
  - support_review
initialPrompts: []
```

Each skill file starts with YAML frontmatter:

```md
---
title: Support Review
description: Use when the user asks to review support case details and plan next checks.
---

# Support Review

...
```

The model sees only the allowed skill name, title, and description. It calls `read_skill` to load the full Markdown body when a skill matches the task.

A skill directory may also contain UTF-8 text resources such as `references/policy.md`. The root `read_skill({ name })` response lists these paths without loading their content; the agent can then call `read_skill({ name, resourcePath })` for one relevant resource. The CLI synchronizes the entire directory as one revisioned skill package. Supported resource file extensions are `.md`, `.txt`, `.json`, `.yaml`, and `.yml`; binary files are intentionally excluded.

## UI Branding

Clients own their favicon and should serve it from `public/`, reference it from `index.html`, and set `ui.faviconUrl` so runtime branding stays explicit. The platform includes `packages/chat-ui/assets/favicon.svg` as an optional fallback asset; pass it as `faviconPath` to `vivdCatalystChatUiPlugin()` when a client intentionally wants that default copied into its build. `ui.faviconUrl` may be an absolute URL or a root-relative path served by the client.

## Model Provider Configuration

OpenAI-compatible providers keep API-specific request shapes behind the model-provider boundary. Agents and tools still see Workshape Catalyst's provider-neutral messages, tools, tool calls, tool results, and usage.

Use `api: responses` for OpenAI reasoning models that combine reasoning, tool calling, or multi-turn workflows. Leave the field unset, or set `api: chat_completions`, for legacy OpenAI-compatible endpoints that still expect `/chat/completions`.

```yaml
infrastructure:
  models:
    openai:
      provider: openai-compatible
      region: global
      api: responses
      model: gpt-5.5
      reasoningEffort: high
      baseUrl: https://api.openai.com/v1
      credentialSecret: OPENAI_API_KEY
      contextManagement:
        compaction:
          compactThresholdTokens: 270000
modelBindings:
  - id: primary
    providerId: openai
    model: gpt-5.5
    agentSelectable: true
    supportsFastMode: false
```

`contextManagement.compaction` enables provider-native server-side compaction
for `api: responses` providers. Catalyst sends the configured threshold as
`context_management[].compact_threshold`, retains the encrypted checkpoint for
later model requests, and keeps the durable conversation transcript unchanged.
Do not configure this block for `api: chat_completions`; startup validation
rejects that unsupported combination.

Agent configuration may override a binding's default with one of Catalyst's product-owned reasoning efforts: `none`, `low`, `medium`, `high`, `xhigh`, or `max`. Only bindings with `agentSelectable: true` are valid agent choices; set it to `false` for internal bindings such as conversation-title generation. The server validates model-binding references and reasoning values; the UI does not accept arbitrary model identifiers.

An agent's `modelBindingId`, `reasoningEffort`, `fastMode`, `userSelectableModelBindingIds`, and `modelReasoningEfforts` are editable in the admin panel exactly when the caller holds the `agent_models.manage` permission, and the server rejects an interactive change to any of them without it. Superadmins hold the permission by default; a superadmin can grant it to individual users. `modelBindingId` and `reasoningEffort` remain valid `editableAgentFields` values for compatibility but no longer have an effect. `catalyst config push` is unchanged and may set all five.

Set `supportsFastMode: true` on a binding whose provider deployment offers a priority processing tier. It defaults to `false`. An agent may set `fastMode: true` only while its binding supports it; saving it for another binding is a validation error, and switching an agent to a binding without support in the admin panel clears it. For fast-mode runs the OpenAI-compatible adapter sends `service_tier: "priority"` on both API shapes. When a chat user picks another model, fast mode applies only if that binding supports it. Fast runs are billed with the rate card's `fast` rates, see above.

Which models chat users may pick is decided per agent, not per binding: each
agent lists them in `userSelectableModelBindingIds`, and any `agentSelectable`
binding may be listed, see
[agent model choice](/configure/config-assets/#models-users-may-choose). The
binding-level `userSelectable` key is still accepted for compatibility but no
longer has an effect. The run API accepts a binding id the resolved agent offers
rather than an arbitrary provider or model name, and an omitted choice keeps the
agent's configured binding. Put shared reasoning defaults on the provider or
agent; add one to a binding only when that model needs a different fallback.

### What the model picker shows

The composer's model picker appears when the agent offers more than one model, or when its
only model offers a choice of reasoning effort. It opens as a two-row menu, model and
reasoning; each row leads to its own panel. Four optional binding keys feed it:

```yaml
modelBindings:
  - id: primary
    providerId: azure-eu
    model: gpt-5.6-sol
    reasoningEffort: medium
    description:
      en: For complex analysis and multi-step work.
      de: Für komplexe Analysen und mehrstufige Aufgaben.
    userSelectableReasoningEfforts: [low, medium, high]
    vendor: openai
    usageTier: high
```

- `description` is the text on the model card, localized like other display strings.
- `userSelectableReasoningEfforts` lists the efforts a chat user may pick for this model.
  Unset, a binding offers those of `low`, `medium`, `high`, `xhigh` and `max` that its model
  takes; a model that takes no reasoning effort offers none. Catalyst passes the pick to the provider unchanged, so list fewer for a model
  that rejects some of them: a run with an effort the model does not accept fails. An empty
  list gives users no choice and leaves the effort to the agent's model settings. The
  effort the agent would use anyway is always offered, so the user can return to it. Where
  neither agent, binding nor provider sets an effort, the picker starts on `medium`; nothing
  is sent to the provider until the user picks one. The run API accepts
  `reasoningEffort` only when the model that will run offers it, and the picked effort is
  stored on the run. A higher effort uses more tokens, which are billed as usual.
- `vendor` names who makes the model, for its logo: `openai`, `anthropic`, `mistral` or
  `google`. Without it the picker reads the vendor from the model id, and shows a neutral icon
  when it cannot tell.
- `usageTier` (`low`, `moderate`, `high`, `very_high`) overrides the usage consumption shown
  for the model. Without it the tier comes from the model's Customer Rate Card entry: three
  parts uncached input price to one part output price per million tokens, below 1 is `low`,
  below 5 `moderate`, below 15 `high`, anything above `very_high`. The bounds are fixed, so
  adding a model never moves another one. A model without a rate card entry shows no tier.

The EU mark is shown for models whose provider entry states `region: eu`.

A model or effort a user picks becomes their own default for new conversations and is stored
with their account, so it follows them across devices. A conversation that already ran stays on
what its latest run used. A user who never picked anything follows the agent's configured model
and effort, so a change to those defaults still reaches them.

## Mail

An instance has no mail until `infrastructure.mail` names a provider. With mail, the login panel
shows a forgot-password link and user administrators can email a set-password link instead of
sharing an initial password. Both need standalone auth.

```yaml
infrastructure:
  mail:
    provider: mailjet
    region: eu
    apiKeySecret: MAILJET_API_KEY
    apiSecretSecret: MAILJET_API_SECRET
    appUrl: https://chat.example.com
    sender:
      fromAddress: noreply@mail.example.com
      fromName: Example Chat # defaults to the client instance display name
      replyTo: support@example.com # optional
```

- `appUrl` is the public URL of the chat UI. Emailed links point there and carry a single-use
  token in the URL fragment.
- The sender domain must be validated with SPF and DKIM in the Mailjet account that owns the
  API key. Use a separate Mailjet sub-account and key per client instance.
- Startup fails when either named secret does not resolve.
- `provider: capture` keeps mails in memory and lists them at `GET /api/v1/dev/captured-mail`.
  That route needs no sign-in, so only `environment: development` config accepts it; staging
  and production config reject it.

Reset links are valid for 60 minutes and invitation links for 7 days. A link stops working once
it is used, once a newer link is issued, or once the password changes another way. A reset
request therefore also replaces a pending invitation link for the same user. Reset
requests always get the same answer, whether or not an account exists. At most three reset
mails an hour go to one mailbox, and at most 200 an hour are sent for requests from one client
address.

## Rate limits

The API limits how often one caller may call one operation. The limits are there to stop
spamming and password guessing; the defaults are far above anything a person or a host
backend does in ordinary use. An instance without the section gets the defaults.

```yaml
rateLimits:
  enabled: true
  readPerMinute: 6000
  writePerMinute: 1200
  signInPerAccountPerMinute: 10
  signInPerAddressPerMinute: 300
```

- `enabled`: `false` turns every limit on API calls off.
- `readPerMinute`: calls to one reading operation, per signed-in person or service. A host
  backend's session-token calls are counted in this class, under its server credential.
- `writePerMinute`: calls to one changing operation, per signed-in person or service.
- `signInPerAccountPerMinute`: sign-in, password reset and password change tries on one account
  from one client address.
- `signInPerAddressPerMinute`: the same tries from one client address, whatever the account.
  Size it for the largest office that reaches the instance through one address.

There are no settings per operation. A refused API key or server credential is counted per
client address at 60 a minute, which is not a setting. A caller over a limit receives 429 with
the code `RATE_LIMITED`, the seconds to wait in `details.retryAfterSeconds` and in the
`Retry-After` header. Behind a second proxy the client address needs
[`trusted_proxies`](/operate/deployment/).

## Operation policy

Every call of a registered operation is checked against a policy value before it runs. The
`policy` section sets the value for operations that nothing else names one for: no declaration
of the release and no setting of an admin. An instance without the section gets the defaults.

```yaml
policy:
  defaults:
    reading: allow
    changing: confirm
```

- `reading`: `allow` runs a reading operation, `deny` refuses it with 403 and the code
  `POLICY_DENIED`.
- `changing`: `allow` runs a changing operation. `confirm` asks the caller to confirm, and a
  person's or a service's own call through the API or the CLI is that confirmation. `approval`
  holds the call for another person. `deny` refuses it.

## Infrastructure

The `infrastructure` section states what an instance runs on: one provider per port. It is
startup config, so a change needs a deploy.

```yaml
infrastructure:
  secrets:
    provider: environment # the default
  models:
    azure-eu:
      provider: openai-compatible
      region: eu
      api: responses
      model: gpt-5.5
      baseUrl: https://example.openai.azure.com/openai/v1
      credentialSecret: AZURE_OPENAI_API_KEY
      authMode: api-key
  mail:
    provider: mailjet
    region: eu
    appUrl: https://chat.example.com
    sender:
      fromAddress: noreply@mail.example.com
  objectStorage:
    files:
      provider: s3
      region: eu
      bucket: example-documents
      bucketRegion: fsn1
      endpoint: https://fsn1.your-objectstorage.com
    workspaces:
      provider: filesystem
      root: /var/lib/vivd-catalyst/example/execution-workspaces/objects
  sandbox:
    provider: docker
    image: ghcr.io/example/catalyst-runner-base:v1
```

- `models` is a map from a provider's name to its entry. The name is what `modelBindings[].providerId`
  and an agent's `modelProviderId` refer to. At least one entry is required; there is no default.
  Config files merge maps key by key, so an entry of a base file stays unless the overlay
  replaces it under the same name.
- `database.poolSize` is how many PostgreSQL connections each process of the instance (the API
  and every worker) keeps at most, 10 unless set; raise it when requests wait for a connection
  and the database's `max_connections` leaves room for all processes together.
- `mail`, `objectStorage.files`, `objectStorage.workspaces` and `sandbox` are left out when the
  instance does not use them. Enabled execution workspaces need `objectStorage.workspaces` and
  `sandbox`.
- `provider` picks the adapter. An unknown provider, an unknown setting or a missing setting
  stops startup, and the message names the field.
- `region` is `eu` or `global` and says where the provider processes the data it is sent. A
  provider that sends data outside the instance (`openai-compatible`, `mailjet`, `s3`) must
  state it. A provider that keeps data inside the instance (`deterministic`, `capture`,
  `filesystem`, `docker`, `local`) must not. A `docker` sandbox with an `endpoint` runs on
  another host and must state it too. A vendor's own region name is a separate setting,
  such as `bucketRegion`.
- A setting whose name ends in `Secret` holds the name of a secret, never its value. The
  `environment` secret provider reads the variable of that name and, when it is not set, the
  file named by the variable `<NAME>_FILE`, which is how a mounted Docker or Kubernetes secret
  is read. A name that does not resolve stops startup; the message names the field and the
  secret name. So does a `<NAME>_FILE` whose file cannot be read or is empty, also for a secret
  the instance may leave unset.
- A secret name reads as an environment variable name: upper-case words joined by underscores,
  at most 64 characters. Anything else is refused and never repeated in a message, so a
  credential pasted where a name belongs does not reach a log.
- The first entry of `models` serves an agent that names no provider. An id made only of digits
  is refused, because such a key is read before the others whatever its place in the file.

Providers and their settings:

| Port            | Provider                    | Settings                                                                                                                                                                                                     |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models`        | `openai-compatible`         | `model`, `api`, `reasoningEffort`, `contextManagement`, `baseUrl`, `credentialSecret` (default `OPENAI_API_KEY`), `authMode`, `organizationSecret`                                                           |
| `models`        | `deterministic`             | `model`. Answers without a model; for tests and local runs.                                                                                                                                                  |
| `mail`          | `mailjet`                   | `appUrl`, `sender`, `apiKeySecret` (default `MAILJET_API_KEY`), `apiSecretSecret` (default `MAILJET_API_SECRET`)                                                                                             |
| `mail`          | `capture`                   | `appUrl`, `sender`. Development only.                                                                                                                                                                        |
| `objectStorage` | `s3` (`files`)              | `bucket`, `bucketRegion`, `endpoint`, `forcePathStyle`, `accessKeySecret` (default `AWS_ACCESS_KEY_ID`), `secretKeySecret` (default `AWS_SECRET_ACCESS_KEY`). Comes with the document-processing capability. |
| `objectStorage` | `filesystem` (`workspaces`) | `root`: a directory that the API and its workers share.                                                                                                                                                      |
| `sandbox`       | `docker`                    | `image`, `cpuCount`, `memoryBytes`, `pidsLimit`, `endpoint` (a `tcp://` or `ssh://` Docker engine on another host; needs `region`). The container has no network and a read-only root file system.           |
| `sandbox`       | `local`                     | None. Development only.                                                                                                                                                                                      |

The platform takes its own secrets from the same provider by fixed names: `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `SERVICE_ACCESS_TOKEN_SECRET`, `CHAT_SESSION_TOKEN_SECRET` and
`CHAT_SERVER_CREDENTIAL`. A data source's `connectionRef: env:NAME` and a seed user's
`passwordEnvName` name secrets too.

The keys `modelProviders`, `mail`, `executionWorkspaces.runner` and
`capabilities.documentProcessing.objectStorage` moved into this section. Config that still
carries one of them does not load: startup stops and names the key and its new place. The
variables `EXECUTION_WORKSPACE_OBJECT_ROOT` and `ARTIFACT_PREVIEW_OBJECT_ROOT` are no longer
read; the directory is `infrastructure.objectStorage.workspaces.root`.

When moving an existing instance:

- A model provider whose old `compliance.residency` was `unknown` needs a decision: `region`
  is `eu` or `global`. State `global` when no EU processing is agreed.
- A deployment that reached S3 through an instance role or another source of the AWS credential
  chain must provide an access key pair as two named secrets. A local S3Mock that ran without
  credentials needs both variables set to any value.
- A deployment that set the workspace object directory through the environment moves the path
  into `infrastructure.objectStorage.workspaces.root` and removes the variable. Keep the same
  directory and the same mount so existing files stay reachable.
- `EXECUTION_WORKSPACE_RUNNER_IMAGE` replaces the image of a `docker` sandbox only.

## Config Is Not A Secret Store

Release config may reference secrets, but it must not contain secret values.

Use runtime env files or a secret manager for:

- model provider API keys
- mail provider API keys
- database passwords
- customer API credentials
- object storage credentials
- server-to-server token exchange credentials

## Change Flow

Treat config changes like code changes:

```text
edit static release config and/or agent working copy
  -> validate static assembly and agent references
  -> run tests
  -> push versioned agent assets when changed
  -> build and deploy the image when static config changed
  -> record active static and asset versions
```

Interactive administration changes apply to new conversations immediately. Pull and commit those changes when the repository should retain them. Static tool availability, model providers and bindings, capabilities, retention, and security policy still require the normal release/deploy flow.
