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

## Guardrails

`guardrails` defines the checks the instance runs before an action happens. It defaults to none. Each entry is keyed by its name: lowercase words of letters and digits joined by hyphens or underscores, at most 64 characters. The name stays the guardrail's id in Studio, in its hits and on an approval request it checked.

```yaml
guardrails:
  no_personal_data:
    displayName: No personal data in skills
    description: Keeps customer details out of shared skills.
    on: approval_request.before_create
    filter:
      kind: skill_change
    check:
      kind: model_judge
      modelBindingId: guardrailCheck
      instruction: Check whether the proposed content contains personal data.
    outcome: warn
  no_iban_in_assets:
    displayName: No IBAN in assets
    on: asset.before_write
    check:
      kind: pattern
      pattern: '(?i)\bDE\d{2}(?:\s?\d{4}){4}\s?\d{2}\b'
      reason: Assets hold no bank account numbers. Remove the IBAN and save again.
    outcome: block
  no_iban_in_apps:
    displayName: No IBAN in published Apps
    on: app.before_publish
    check:
      kind: pattern
      pattern: '(?i)\bDE\d{2}(?:\s?\d{4}){4}\s?\d{2}\b'
      reason: Apps hold no bank account numbers. Remove the IBAN and publish again.
    outcome: block
```

A guardrail answers one event. A rule that should hold wherever content can go live needs one entry per event: the IBAN rule above stops an asset write and, with its second entry, the publish of an App, so an App whose revision was written before the rule existed cannot go live with an IBAN either.

| Field                        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName`, `description` | What Build shows. Without `displayName` the name is shown.                                                                                                                                                                                                                                                                                                                                                                                    |
| `on`                         | The event the guardrail answers: `asset.before_write` (a save, a push, a revert, an App written from a Page, an agent's save and the skill change it proposes, again when that change is approved), `operation.before_call` (every call of an operation), `app.before_publish`, `workflow.before_publish`, `data_store.before_publish` (the revision a publish makes live, with its files) or `approval_request.before_create`.                   |
| `filter`                     | Narrows the event: `kind` (the asset's kind, or the request's kind such as `skill_change`), `operation` (a name or a prefix ending in `.*`), `origin` (`agent`, `user`, `cli`, `mcp`, `app`, `workflow`, `schedule`) and `agent`, as far as the event knows them. Without it, everything at the event.                                                                                                                                          |
| `check`                      | `pattern`: an RE2 expression (no backreferences, no lookaround), with the `reason` a person is shown. `model_judge`: a model of `modelBindingId` reads the content against `instruction` (at most 8,000 characters, any language) and answers with no tools. Either may name the event's `fields`: `name` and `content` of an asset, `input` of a call, `summary` and `newContent` of a request.                                                 |
| `outcome`                    | What a hit does: `allow`, `warn`, `require_approval` (a changing call waits for an approval in the Inbox; the App draft an agent's `page.save` writes cannot wait, so there it is a `block`) or `block`. Every guardrail that applies runs, and the strictest answer wins.                                                                                                                                                                                                                                                       |

Content longer than 2 Mi characters is not read in part: a guardrail that blocks or asks for an approval answers it as a match; one that warns warns. A text file in UTF-8, or in UTF-16 with its byte order mark or without one where at least 90% of the bytes at one parity of its first KiB are NUL and at most 10% at the other, is read as text. Any other file is read by a `pattern` as its printable runs (printable ASCII, tab and line ends) of at least 4 characters, as `strings` finds them, so text beside a NUL byte is still found and a photo adds next to nothing. A `model_judge` reads the text files and, of an image or a font (PNG, JPEG, GIF, WebP, ICO, WOFF, WOFF2, TrueType, OpenType), the printable runs of at least 16 characters, which a photo has next to none of and text put into the file has throughout; any other file that is no text leaves it nothing it can judge, which a judge that blocks or asks for an approval answers as a match. Such a refusal does not say to try again, as nothing about it is temporary; a judge that failed or timed out does.

All guardrails bound to an event run concurrently. For skill changes, the summary and proposed new text are sent to the configured model provider; existing skill text and replaced text are excluded. Select a provider and binding approved for that content. Each check is a model call of the instance: it counts toward the usage budgets and safeguards and leaves one usage record with the purpose `guardrail_judge`, also when it fails or times out. The record names the originating conversation when there is one and never an agent run.

`warn` stores a visible warning and leaves the decision with the approver. `block` refuses a violating proposal and returns the reason to the agent without storing a request. If a check cannot be evaluated, including provider failures or the 60-second timeout, `warn` stores a neutral warning and `block` refuses the proposal, so a blocking guardrail never lets unchecked content through. When a usage limit of the instance refuses the check, the reason given to the agent says that the limit is reached. When a skill change is approved, the skill as the approval would write it is checked again at `asset.before_write`: a block then leaves the skill unchanged, and the request ends as not applied with the guardrail's reason. Undoing an approved change writes the earlier revision back, which is checked the same way: a block refuses the undo and the request stays approved. A call that waited for an approval is checked again before it runs. Request kinds without a proposed-content extractor are not checked.

Every warning and block is kept as a hit: the guardrail, the outcome, its one-sentence reason and the kind of request, never the checked content and never the person. A block that answered a `require_approval` where the action could not wait for an approval, such as the App draft an agent's `page.save` writes, says so (`convertedFrom: require_approval` of `guardrails.list_hits`; "Blocked: approval could not wait" on the guardrail's page). The judge is told to word its reason without quoting the content. Studio > Guardrails lists the guardrails read-only, and a guardrail's page counts its hits for the last 7 and 30 days and lists the newest 50, for holders of `guardrail.read` (administrators). Hits are counted by rule and period and never listed by person, because a list of who tripped which rule would let the instance monitor employees, which in Germany needs the works council's co-determination (§87(1) no. 6 BetrVG). Who made a request is in the audit log: `approval_request.created` for a request a guardrail warned on, and `operation.failed` of the agent's `propose_skill_change` call for one it blocked. Hits are deleted with the audit events, after `retention.auditDays`. Creation audit metadata contains only guardrail names and statuses, never proposed content or reasons. Stored check messages remain part of the approval request.

The API seeds the guardrails into the asset store when it starts, published, so a change of `guardrails` shows in Studio after a restart. They are the operator's floor: they cannot be changed, unpublished or deleted through the asset operations or the CLI, and they run from release config itself. Further guardrails are written as assets and published by a holder of `guardrail.publish` (see [config assets](/configure/config-assets/#guardrails-as-assets)); they add checks to the floor and never remove one. A name of release config that a guardrail asset holds already is left to the asset in Studio and logged at start; the floor's rule of that name runs all the same.

### From `approvalChecks`

`guardrails` replaces `approvalChecks`. For this release a config that still has `approvalChecks` loads each check as the guardrail it became: `id` becomes the name, `appliesTo` the `filter.kind`, `modelBindingId` and `instruction` the `model_judge` check, and `onFail` the `outcome`, with `on: approval_request.before_create`. A config with both keys is refused at start. The next release refuses `approvalChecks`.

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
- an enabled tool has the permission mode `approval_required`, which this release cannot run

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

## Links And Images In Replies

A reply in the chat and a Markdown file in the preview load nothing from another address. An image, whether written in Markdown or as HTML, remote, relative or a `data:` address, is never loaded; its description is shown in its place. A link stays a link when it points to the instance itself, is a `#fragment` or a `mailto:` address. `replies.allowedLinkHosts` names the other hosts links may point to:

```yaml
replies:
  allowedLinkHosts:
    - example.com
    - "*.example.com"
```

An entry is a host name, or `*.` and a domain for every subdomain of it but not the domain itself. A link to any other host is shown as text followed by its address, so a person can still read and copy it. The default is an empty list. The setting applies when a reply is shown, so it also governs replies written before a change.

The renderer is not the only line. A Mermaid diagram draws into the page outside it, and a node label, an image shape or the diagram's theme CSS can name an image. The interface's page therefore carries a content policy in a meta tag that the chat UI's Vite plugin writes into `index.html` at build: images, media, fonts and connections come only from the interface itself, `data:` and `blob:` addresses, the API when the build names another origin (`VITE_CHAT_API_URL`, or `VITE_CHAT_API_PORT` on the page's host), and the hosts of `ui.logoUrl`, `ui.logoUrlDark` and `ui.faviconUrl`. A logo on another host therefore needs a new build of the interface image after a change. Scripts, styles and frames are not limited by it: generated views and Apps run in documents with policies of their own.

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

| Kept                                                                 | With                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Text, headings, paragraphs, sections, `pre`, `blockquote`, `details` | `class`, `id`, `style`, `title`, `lang`, `dir`, `role`, `hidden`, `aria-*`, `data-*`                                                 |
| Lists and tables                                                     | also `colspan`, `rowspan`, `headers`, `scope`, `span`, `start`, `value`                                                              |
| Inline formatting, `time`, `meter`, `progress`                       | their value attributes                                                                                                               |
| `a`                                                                  | its text, never an address                                                                                                           |
| `img`                                                                | `alt`, `width`, `height`, and `src` only when it is a `data:` address of type `image/png`, `image/jpeg`, `image/gif` or `image/webp` |
| `style` blocks and `style` attributes                                | only without `url(` other than `url(#id)`, `@import`, `image-set(`, `image(`, `src(` or a backslash                                  |
| Inline `svg` with shapes, `text`, gradients and clip paths           | geometry and paint attributes, no `href`                                                                                             |

Everything else is left out with what is inside it: `script`, `link`, `meta`, `base`, `area`, `form` and its controls, `iframe`, `object`, `embed`, `canvas`, `video`, `audio`, SVG `a`, `image`, `use` and `foreignObject`, every event handler attribute, `href`, `ping`, `target`, `srcset` and `srcdoc`.

The limits:

- **WebRTC.** A view that runs scripts can send UDP packets to a host its script names. No content policy and no sandbox flag of current browsers forbids WebRTC. The view's bootstrap removes `RTCPeerConnection` and its prefixed variants from the view's window. That is hardening and not a boundary: a script gets the constructor back in a frame it writes itself.
- **Links in a view that runs scripts.** The view's bootstrap takes the address from every link, image map area and SVG link, and cancels a click on one that still has an address. That is hardening and not a boundary: a script can put a link back where the bootstrap does not run, in a frame it writes itself, and a click on it with a modifier key or the middle button then opens the address in a new tab. A link inside a closed shadow root keeps its address, because the bootstrap does not look into shadow roots. Opening a link from the context menu and dragging a link out of a view have not been tested.
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

### Documentation address

`ui.docsUrl` is the address the interface's links to the documentation start from: the Documentation item of the account menu, and the "Learn more" links on pages such as Access.

```yaml
ui:
  docsUrl: https://docs.workshape.ai/catalyst
```

- It has no default. An instance that leaves it out shows no Documentation item and no "Learn more" link, and no empty row in their place.
- Set your own address to send people to your own handbook. The account menu opens the address as it is. A "Learn more" link adds the path of a page of this documentation to it, such as `/operate/how-rights-work/`, so an address of your own needs the pages at those paths.
- `docsUrl: null` clears an address that a base file set, for one environment that [extends](#sharing-config-across-environments-with-extends) it.
- Only an `http` or `https` address is taken. Anything else, such as a path, a bare host or a `javascript:` address, stops the start with a validation error.

The address is part of the public branding the interface reads, so it is not a place for a link that carries a token.

## Model Provider Configuration

OpenAI-compatible providers keep API-specific request shapes behind the model-provider boundary. Agents and tools still see Workshape Catalyst's provider-neutral messages, tools, tool calls, tool results, and usage.

Tools reach an OpenAI-compatible provider under a readable name derived from the tool name (dots become underscores), shortened with a short suffix when the name is too long or would clash.

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

An agent's `modelBindingId`, `reasoningEffort`, `fastMode`, `userSelectableModelBindingIds`, and `modelReasoningEfforts` are editable in Studio exactly when the caller holds the `agent_models.manage` permission, and the server rejects an interactive change to any of them without it. Superadmins hold the permission by default; a superadmin can grant it to individual users. `modelBindingId` and `reasoningEffort` remain valid `editableAgentFields` values for compatibility but no longer have an effect. `catalyst config push` is unchanged and may set all five.

Set `supportsFastMode: true` on a binding whose provider deployment offers a priority processing tier. It defaults to `false`. An agent may set `fastMode: true` only while its binding supports it; saving it for another binding is a validation error, and switching an agent to a binding without support in Studio clears it. For fast-mode runs the OpenAI-compatible adapter sends `service_tier: "priority"` on both API shapes. When a chat user picks another model, fast mode applies only if that binding supports it. Fast runs are billed with the rate card's `fast` rates, see above.

Which models chat users may pick is decided per agent, not per binding: each
agent lists them in `userSelectableModelBindingIds`, and any `agentSelectable`
binding may be listed, see
[agent model choice](/configure/config-assets/#models-users-may-choose). The
binding-level `userSelectable` key is still accepted for compatibility but no
longer has an effect. The run API accepts a binding id the resolved agent offers
rather than an arbitrary provider or model name, and an omitted choice keeps the
agent's configured binding. Put shared reasoning defaults on the provider or
agent; add one to a binding only when that model needs a different fallback.

### Gemini on Vertex AI

The `google-vertex` provider calls Gemini models through Vertex AI `generateContent`. The
entry's `region` decides where the call goes: `eu` uses Google's European endpoint
`aiplatform.eu.rep.googleapis.com` with the location `eu`, and `global` uses
`aiplatform.googleapis.com` with the location `global`. There is no setting for another endpoint
or location.

```yaml
infrastructure:
  models:
    vertex:
      provider: google-vertex
      region: eu
      model: gemini-3.1-flash-lite
      projectId: my-gcp-project
      credentialSecret: GOOGLE_VERTEX_CREDENTIALS
      labels:
        instance: internal-dev
        environment: development
modelBindings:
  - id: document-extraction
    providerId: vertex
    model: gemini-3.1-flash-lite
    agentSelectable: false
```

`credentialSecret` names the secret that holds the JSON key of a service account with the role
**Vertex AI User**. With the `environment` secret provider, mount the key file and set
`GOOGLE_VERTEX_CREDENTIALS_FILE` to its path. Every process that creates the entry needs the
secret: the API and the agent run worker create every entry of `infrastructure.models`, and the
document worker creates the entry behind the extraction binding. A key that is not a service
account key stops startup; the message names the secret and none of its content.

The adapter reads text, images and PDF documents, answers in a JSON format and streams. It
declares no tool calls, no web search, no reasoning efforts, no fast tier and no server-side
compaction, so a call that asks for one of them is refused before it is sent. In this version
the adapter serves the product's own calls, such as document extraction, and no agent: every
agent run offers tools, and Gemini needs its thought signatures sent back with a tool call,
which the adapter does not carry yet. A binding on a `google-vertex` entry must therefore state
`agentSelectable: false`; startup stops on one that does not and names the binding.

Optional `labels` are static operator metadata attached to both ordinary and streaming
requests for Google PayGo billing attribution. Use at most 64 labels, with lowercase ASCII
letters, digits, underscores or hyphens; keys start with a letter and keys and values are at
most 63 characters. Keep customer content and personal data out of labels. Labels do not
create an access boundary, and billing reports take time to populate.

The provider's check on **Instance > Infrastructure** asks Google for a token with the key. It
shows that the key is taken. It does not show that the account may call the model on Vertex.

### Claude on Amazon Bedrock

The `aws-bedrock` provider calls Claude models through the Bedrock runtime in Frankfurt,
`bedrock-runtime.eu-central-1.amazonaws.com`. The entry must state `region: eu`.

```yaml
infrastructure:
  models:
    bedrock:
      provider: aws-bedrock
      region: eu
      accountId: "123456789012"
      model: arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abcd1234efgh
      credentialSecret: AWS_BEARER_TOKEN_BEDROCK
modelBindings:
  - id: claude-sonnet
    providerId: bedrock
    model: arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abcd1234efgh
    label: Claude Sonnet 4.6
    vendor: anthropic
usage:
  costs:
    customer:
      id: example-customer
      version: "2026-10"
      currency: EUR
      models:
        - providerId: bedrock
          model: arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abcd1234efgh
          uncachedInputPricePerMillionTokens: <your price, above zero>
          cachedInputPricePerMillionTokens: <your price, above zero>
          outputPricePerMillionTokens: <your price, above zero>
```

`accountId` is the AWS account the instance's profiles belong to, twelve digits in quotes. It is
no secret. `model` is the ARN of an application inference profile of that account in
`eu-central-1`, in the entry and in every binding on it. AWS attributes usage and cost to that
profile, so the profile is what separates one consumer's calls from another's. A model id, a
shared profile id such as `eu.anthropic.…`, a foundation model ARN, a profile of another region
and a profile of another account stop startup, and a call that names one is refused before
anything is sent; the message says why and does not repeat the id. An ARN says nothing a person
can read, so give each binding a `label` and a `vendor`. The usage ledger and the rate card keep
the ARN, which is what joins a call to the AWS bill. Log lines, the audit and refusals name the
binding.

What the adapter enforces, and what it cannot:

- The adapter sends every request to the Frankfurt endpoint, follows no redirect, and has no
  setting for another endpoint or AWS region. It calls only profiles of the configured account
  in `eu-central-1`.
- Where the model runs is decided by the profile, not by the adapter. The operator makes sure
  each application inference profile is built on an EU model or an EU inference profile
  (`eu.…`), never on a global one.
- The operator gives the key an IAM policy that allows `bedrock:InvokeModel` and
  `bedrock:InvokeModelWithResponseStream` on these profiles alone and denies every other region.
- The operator sets Bedrock's data retention for the account to none and leaves model invocation
  logging off, or accepts that prompts and answers are stored where the logging writes them.

`credentialSecret` names the secret that holds a Bedrock API key, sent as a bearer token. The
API and the agent run worker create every entry of `infrastructure.models` and need the secret;
a capability worker needs it when one of its bindings is on the entry.

**Prices are required.** Bedrock bills every token to the profile, so the instance makes no call
it cannot price. Startup stops when the entry's own model or the model of a binding on it has no
row in `usage.costs.customer.models` with the entry's id as `providerId`, the same ARN as
`model`, and a price above zero for uncached input, cached input and output. The message names
the binding or the entry.

The adapter reads text, images and PDF documents, calls tools, also several at once, streams,
thinks and answers in a JSON format. A binding on it can be chosen for agents. It declares no
web search, no fast tier and no server-side compaction; a call that asks for one of them is
refused before it is sent, and an agent with web search configured runs without it. The adapter
asks for no prompt cache.

**Thinking.** The reasoning efforts `low`, `medium` and `high` ask for adaptive thinking
(`thinking: { type: adaptive }`) with that effort; `none`, or no effort, sends no thinking
setting. `xhigh` and `max` are not offered. The adapter sends no thinking budget: the output
limit of 16,000 tokens is the one limit on thinking and answer together, so thinking can never
ask for more than the limit, and a long thought leaves a shorter answer. Thinking is billed as
output and is part of the output tokens of the usage record; it has no count of its own. A
person reads the model's thinking as reasoning while it streams. When the model thinks and then
calls a tool, its thinking blocks, with their signatures and any redacted block, go back to
Bedrock unchanged with the tool's result. They are held for the run that made the call and are
not stored with the conversation; a turn of an earlier run is sent without its thinking.

**Documents.** A PDF is sent as a document block. PDF is the one document format a call can
carry, on every provider; a file of another format is not sent as a document. A document is never left out of a request: a
call with a document above the limits below is refused before anything is sent, with the reason
`document_too_large` or `document_too_many_pages`.

**JSON answer format.** A call that asks for an answer format sends the schema as the Messages
format's own structured output (`output_config.format`). No tool is forced for it, so tools and
thinking work in the same call. Bedrock compiles the schema and takes a subset of JSON Schema:
the adapter states `additionalProperties: false` on every object and leaves out bounds on
numbers, on string lengths and on list lengths above one, which the caller still checks on the
answer. A schema that refers to itself is refused by Bedrock.

**Claude 5.5 profiles are not supported yet.** The adapter is checked against Claude Sonnet 4.6,
on recorded exchanges. The Claude 5.5 models think by default and bill thinking as output. The
adapter now steers thinking and sends it back, but none of this has run against a 5.5 model.
Keep a binding on a 5.5 profile out of the config until it has.

Limits of one request:

- An answer has at most 16,000 output tokens, the amount admission reserves for a call, so an
  answer never uses more output than the budget held for it. A longer answer ends there. Every
  Claude model from the 4 generation on allows this much; Bedrock refuses the request for an
  older model with a smaller limit.
- A PDF has at most 4.5 MB, and the PDFs of one request have at most 100 pages together. AWS
  states the 100 pages; it states no size of one PDF for this API, so 4.5 MB is the smallest
  document limit AWS states for Bedrock. Pages are counted from the page objects the file shows;
  a PDF that keeps them in compressed object streams is sent, and Bedrock judges it.
- An image above 3.75 MB is left out. Of more than 20 images the newest 20 are sent. The model
  is told what was left out.
- A request above 20 MB is not sent; the user reads that the conversation is too long.
- A stream that sends nothing for 10 minutes fails the call. Such a call is not sent again.

Bedrock's refusals reach people as the product's own messages. The provider's words, with any
account id masked, are written to the `model_provider.error` log line together with the
exception name and the AWS request id. A refused key, permission, bill or request is not sent
again, nor is a failure of a type the adapter does not know. Throttling, a timeout and a failing
or overloaded model are sent again within the gateway's bounds.

The provider's check on **Instance > Infrastructure** sends the key with a request Bedrock
refuses as invalid. It shows that the key is taken. It does not show that the key may call a
profile, or that the account has access to the model behind it: those answer with status 403 on
the first call.

Document extraction of the document processing capability, a paid capability, names its model
binding in `capabilities.documentProcessing.extraction.modelBindingId`. The binding's model must
read documents and answer in a JSON format, and its entry must state `region: eu` or keep data
inside the instance; anything else stops startup. Each extraction call is admitted against the
budget and recorded in the usage ledger with the purpose `document_extraction`, the provider
entry and its region.

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
    label: GPT-5.6 Sol
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
- `label` is the name people read for the model, in the picker, the agent editor and the
  Access page. Without it the name is made from the model id, which suits a vendor's own model
  name. Set it where `model` is a deployment name you chose, as on Azure: `model:
acme-gpt-5.6-sol` with `label: GPT-5.6 Sol`. Usage keeps the model id, which is what the
  provider bills.
- `vendor` names who makes the model, for its logo: `openai`, `anthropic`, `mistral` or
  `google`. Without it the picker reads the vendor from the model id, and shows a neutral icon
  when it cannot tell.
- `usageTier` (`very_low`, `low`, `moderate`, `elevated`, `high`, `very_high`) overrides the
  usage consumption shown for the model. Without it the tier comes from the model's Customer
  Rate Card entry: three parts uncached input price to one part output price per million
  tokens, in the rate card's currency. Each tier ends at twice the price of the one before:
  below 1.25 is `very_low`, below 2.5 `low`, below 5 `moderate`, below 10 `elevated`, below 20
  `high`, anything from 20 `very_high`. The bounds are fixed and the same for every instance,
  so adding a model never moves another one. Set `usageTier` where the price misleads, for
  example for a model that writes many more output tokens for the same work. A model without
  a rate card entry shows no tier.

The EU mark is shown for models whose provider entry states `region: eu`.

A model or effort a user picks becomes their own default for new conversations and is stored
with their account, so it follows them across devices. A conversation that already ran stays on
what its latest run used. A user who never picked anything follows the agent's configured model
and effort, so a change to those defaults still reaches them.

### Embedding models

Knowledge Bases with semantic search turn their passages and every search query into vectors.
The model that does this is a model binding of kind `embedding`:

```yaml
modelBindings:
  - id: knowledgeEmbedding
    providerId: azure-eu
    kind: embedding
    model: acme-text-embedding-3-large
    dimensions: 1536
knowledge:
  defaultEmbeddingBinding: knowledgeEmbedding
usage:
  costs:
    customer:
      models:
        - providerId: azure-eu
          model: acme-text-embedding-3-large
          uncachedInputPricePerMillionTokens: 0.12
          cachedInputPricePerMillionTokens: 0
          outputPricePerMillionTokens: 0
```

- `kind: embedding` marks the binding. A binding without `kind` is a chat binding, as before.
- `dimensions` is the length of every vector, and is required. The `openai-compatible` adapter
  sends it to the model, which shortens its vectors to that length. It is at most 16,000; stay
  at or below 2,000 where a Knowledge Base may later need an approximate index.
- The binding uses the key of its provider entry and brings none of its own. On Azure OpenAI the
  entry's v1 endpoint serves both chat and embeddings, and `model` is the name of the embedding
  deployment.
- Every binding of kind `embedding` is approved for Knowledge Bases on the instance.
  `knowledge.defaultEmbeddingBinding` names the one a Knowledge Base uses unless it names
  another. Without it the instance offers no semantic search; keyword and structured Knowledge
  Bases work all the same and call no model.
- An embedding binding is never offered to agents and answers no chat call: an agent cannot
  pick it, and conversation titles and guardrails cannot name it.
- An embedding call is admitted and recorded like every other model call, with no output tokens,
  the purpose `knowledge_embedding` for ingestion and re-index or `knowledge_query` for a search,
  and the provider entry, its region and the binding. Its cost comes from the rate card's
  uncached input price; under a spend budget the model needs a row there.

Startup stops, naming the binding, when:

- an embedding binding's provider entry has a region other than `eu`. Embeddings send the text of
  documents and queries to their provider; only an EU entry, or a provider that keeps data
  inside the instance such as `deterministic`, is approved for them;
- an embedding binding has no `dimensions`, or sets `agentSelectable: true`;
- a chat binding sets `dimensions`;
- its provider does not embed. `openai-compatible` and `deterministic` embed; `google-vertex` and
  `aws-bedrock` do not;
- `knowledge.defaultEmbeddingBinding` names no binding of kind `embedding`;
- a guardrail or conversation title generation names an embedding binding.

The `deterministic` provider embeds with vectors made from a hash of each text: the same text
gives the same vector, and nearness of meaning is not modelled. It is for tests and development.

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
  person's or a service's own call through the API or the CLI is that confirmation. `deny`
  refuses it. `approval` holds a person's call until a person with the right to approve
  decided it in the Inbox: the caller receives `202` with the run. An approval queues the call, and
  the instance checks it again before it runs. A declined call answers `DECLINED`, and one nobody decided within 7 days answers
  `OPERATION_EXPIRED`. A call of a Service Principal cannot be held and is refused with
  `POLICY_DENIED`, a release push included. An agent's run cannot wait either, so startup refuses an
  enabled changing tool that would wait under this default. Such a tool declares
  `permission.mode` `allow` or `deny`. See [How rights work](/operate/how-rights-work/#approvals).

Calls that carry a secret do not follow an inherited `approval`: issuing an API key
(`api_credentials.create`), whose answer is the key, shown once to the person who asks; setting
a user's password (`users.password.reset`); and creating a user with a first password
(`users.create` with `passwordSignIn`). A held call keeps its input and shows it to whoever
decides, and a key shown later reaches nobody, so such a call cannot wait for somebody else.
Under `changing: approval` it is not refused: it runs on its caller's own word, as under
`confirm`, and its run records the decision with the reason `inherited_approval_not_applied`.
To require an approval for one of them on purpose, name the operation or its prefix in a policy
setting (`api_credentials.create` or `api_credentials.*` with the value `approval`). Such a
setting refuses the call with 403 and the code `POLICY_DENIED`, since a secret cannot wait:
nobody issues a key or sets a password while the setting stands. A `users.create` without a
password carries no secret and waits like any other change. A run never keeps the answer of
such a call, and the hash it keeps of the input is taken with the password left out.
See also [Governance](/operate/governance/#inbox).

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
  provider that sends data outside the instance (`openai-compatible`, `google-vertex`, `aws-bedrock`,
  `mailjet`, `s3`) must state it. A provider that keeps data inside the instance (`deterministic`, `capture`,
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
| `models`        | `google-vertex`             | `model`, `projectId`, `credentialSecret` (default `GOOGLE_VERTEX_CREDENTIALS`): the JSON key of a service account. Gemini on Vertex AI; `region` decides the endpoint and location.                          |
| `models`        | `aws-bedrock`               | `accountId`: the AWS account of the profiles; `model`: the ARN of an application inference profile of that account in `eu-central-1`; `credentialSecret` (default `AWS_BEARER_TOKEN_BEDROCK`): a Bedrock API key. Claude on Amazon Bedrock; `region` must be `eu`; every model needs a price. |
| `models`        | `deterministic`             | `model`. Answers without a model; for tests and local runs.                                                                                                                                                  |
| `mail`          | `mailjet`                   | `appUrl`, `sender`, `apiKeySecret` (default `MAILJET_API_KEY`), `apiSecretSecret` (default `MAILJET_API_SECRET`)                                                                                             |
| `mail`          | `capture`                   | `appUrl`, `sender`. Development only.                                                                                                                                                                        |
| `objectStorage` | `s3`                        | `bucket`, `bucketRegion`, `endpoint`, `forcePathStyle`, `accessKeySecret` (default `AWS_ACCESS_KEY_ID`), `secretKeySecret` (default `AWS_SECRET_ACCESS_KEY`). Any S3-compatible store.                       |
| `objectStorage` | `filesystem`                | `root`: a directory that the API and its workers share.                                                                                                                                                      |
| `sandbox`       | `docker`                    | `image`, `cpuCount`, `memoryBytes`, `pidsLimit`, `endpoint` (a `tcp://` or `ssh://` Docker engine on another host; needs `region`). The container has no network and a read-only root file system.           |
| `sandbox`       | `local`                     | None. Development only.                                                                                                                                                                                      |

Every stored byte goes through one object storage port. `objectStorage.files` holds uploaded
documents and what is prepared from them, and is used by the document processing capability, a
paid capability; `objectStorage.workspaces` holds workspace files,
their source files and preview images. Each store names its own provider and its own bucket or
directory, and either provider serves either store. Object keys are the same in both providers
and did not change with the port, so a store written by an earlier release is read as it is.

The platform takes its own secrets from the same provider by fixed names: `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `SERVICE_ACCESS_TOKEN_SECRET`, `CHAT_SESSION_TOKEN_SECRET` and
`CHAT_SERVER_CREDENTIAL`. A data source's `connectionRef: env:NAME` and a seed user's
`passwordEnvName` name secrets too.

### Reading what an instance runs on

The page **Instance > Infrastructure** in the settings and `GET /api/v1/instance/infrastructure`
list every configured entry of this section and the database: the provider, its region, the host
it calls or its bucket, its secrets with whether each is set, and the result of its last check.
Both need `users.manage` and change nothing. A secret value, a connection string, a key and a
path on the host are never part of the answer.

A secret that is set is shown by its name. One that is missing is shown by the key of the config
that names it, such as `credentialSecret`: what stands there resolves to nothing, so the page
does not repeat it. A host is shown when it is a bare host with an optional port and a bucket
when it reads as an S3 bucket name. Anything else is shown as "not shown", and the server log
names the provider and the field in a warning, without the value.

A check is the cheapest authenticated read a provider has: the list of models of a model
endpoint, the account of a Mailjet key pair, one `HEAD` of the bucket of an S3 store, the `head`
of a key that is never written in a filesystem store, one query against the database, the
version of the Docker engine for the sandbox. It generates nothing, sends no mail, writes nothing
and creates no bucket. Creating the provider and asking it end together after five seconds as
`timeout`. The API runs its checks every five minutes, all at once. The workspace command worker
checks the sandbox on the same schedule, because it alone reaches it; an instance without that
worker shows the sandbox with no check reported. **Check now** and
`POST /api/v1/instance/infrastructure/check` run the API's checks once more, at most once a
minute for the whole instance; a call inside that minute answers `429 RATE_LIMITED`. Opening the
page asks no provider.

A failed check shows a class and a sentence of the product: `unreachable`, `timeout`,
`access_denied`, `not_found`, `bucket_missing`, `rejected` or `failed`. What the provider itself
answered is not shown, logged or returned. The outcomes and the time of the last manual check are
kept in the database, in one row of `infrastructure_check_state` per instance, so every API
process shows the same and the results survive a restart. A failing provider does not change
`/ready`.

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

## Connections

`connections` names the Connections of the instance. It needs the module [`connections`](/configure/modules/#connections); with the module off the section is read and nothing is seeded.

```yaml
modules:
  connections:
    enabled: true

connections:
  crm:
    connectorType: mcp
    displayName: CRM
    description: Customer records, read-only.
    settings:
      url: https://mcp.crm.example.com/mcp
    authScheme: bearer
    secret: CRM_MCP_TOKEN
    operations:
      - name: search_customers
        effect: reading
        exposure: [agent]

secretStore:
  keys:
    - id: k1
      ref: CATALYST_SECRET_STORE_KEY

egress:
  allow:
    - protocol: https
      host: mcp.crm.example.com
      port: 443
```

Each key under `connections` is the name of a Connection. A name that starts with the prefix of a [Namespace](/operate/rights-and-namespaces/) belongs to that Namespace: whoever holds `connection.read` or `connection.use` there holds it on this Connection too, so choose the name with that in mind. An entry takes `connectorType`, `displayName`, `description`, `settings`, `authScheme`, `secret` and `operations`, and nothing else. `settings` is checked against the strict schema of the connector type before anything is stored, and a `connectorType` this build does not ship stops startup with the place of the fault. An entry of `operations` takes `name`, `effect` (`reading` or `changing`), `exposure` (any of `agent`, `bridge`, `workflow`) and optionally `policy` and `schemaFingerprint`. What stands in the list is accepted; nothing else of the outside system can be called.

`secret` is the name of a secret, resolved like every other secret of the instance: from the environment variable of that name or from the file `<NAME>_FILE` points at. It is the only place of a Connection where a secret may stand, and it never holds the value. An `authScheme` other than `none` needs it, and `none` refuses it.

### What a start does

The API process reconciles the stored Connections with this section each time it starts, in one transaction under one lock, so several API processes starting together write once. Workers do not seed.

- A new entry becomes a Connection with `origin: release` at revision 1. A changed entry becomes a new revision. An unchanged entry writes nothing.
- An entry that is gone removes its Connection, its stored secret, its state and the grants that allow something on that one Connection. A deny on it stays with the name, as for every asset. A later release also removes what was read from the outside system about it.
- A renamed entry is a removed entry and a new one: the new Connection starts at revision 1 with no grants of its own, and grants have to be written again.
- The value of `secret` is read once and stored encrypted. A changed value becomes the next version of the secret and no new revision of the Connection. A variable that is not set leaves the Connection in the state `needs_configuration`, and a call of it is refused with `connection_not_configured`.
- A Connection created on the instance is never touched. An entry with the name of such a Connection stops startup.

A seeded Connection is read-only on the instance: `read_only_origin`. Rotate a credential by changing the value of the variable and restarting.

### Secret Store keys

`secretStore.keys` lists the keys that encrypt Connection secrets, each with an `id` and a `ref`, the name of the secret that holds the key. A key is 32 random bytes in base64, for example from `openssl rand -base64 32`. The first key encrypts; every listed key decrypts.

- With at least one entry under `connections`, the first key must resolve. Otherwise startup stops and names the variable, for example `The Secret Store key 'CATALYST_SECRET_STORE_KEY' is not set`.
- A later key that is not set is skipped with a warning that names it. A secret only that key opens reads as `secret_unreadable`, and no call of its Connection is attempted.
- To change the key, put the new key first and keep the old one in the list. A secret that comes from `secret` is sealed again under the first key at the next start. Remove the old key once no row names its `id`.

Secrets are stored with AES-256-GCM, a random 12-byte nonce for every encryption, and associated data made of the instance, the Connection, the credential subject and the version of the secret. A row copied to another Connection does not open. The database holds ciphertext only, so a database backup restores no credential without the key: back the key up apart from the database. A lost key is not recovered; set the secrets again.

Nothing returns a stored secret: no operation, route, CLI command, export, log line, audit event or error. A person sees whether a secret is set and its version.

### Egress

`egress.allow` is the list of outside targets a Connection may reach. It is empty unless set, and an empty list refuses every target. `egress.allowPublicHttps` opens every public HTTPS host beside the list; it is off unless set.

| Key        | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `protocol` | `https`, `http` or `postgres`.                                            |
| `host`     | One exact host name or one literal address. No wildcard, no suffix match. |
| `port`     | The one port. A default port is written out.                              |
| `network`  | `public`, the default, or `private`.                                      |
| `cidrs`    | With `private`: the address ranges the host may resolve into.             |

Every connection a Connection opens is checked against this list before a credential is resolved, whatever its connector type:

- Protocol, host and port must equal one entry.
- The host is resolved at the check, and every address it answers is judged. For a `public` entry, one answer that is loopback, link-local, a cloud metadata address or a private range refuses the target, also written as an IPv4-mapped IPv6 address. For a `private` entry, every answer must lie in the entry's `cidrs`.
- The connection goes to the address that was checked, with the host name unchanged for TLS, so a second DNS answer changes nothing.
- A redirect and a returned download address are checked as new targets, and the credential is sent to the origin it was configured for and to no other.
- An address with a user name or a password is refused.
- The instance's own database host and port are refused whatever the list says, by name and by address. While the database host does not resolve, every target on its port is refused. When the database address cannot be read as one host and one port, startup logs a warning and every `postgres` target is refused. That is so for a Unix socket, for an address that names several hosts, and for an address without a port while `PGPORT` is set. Give the address as `postgres://host:port/database`.
- Plain `http` is accepted for a `private` entry only.
- Link-local addresses (`169.254.0.0/16`, `fe80::/10`) are reached by no entry. A `private` entry whose `cidrs` cover them stops startup with the range named. Loopback and the private ranges are reachable where a `private` entry names them.
- An IPv4 address carried inside an IPv6 one (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo) is judged as that IPv4 address.

```yaml
egress:
  allow:
    - protocol: http
      host: mcp-internal
      port: 8080
      network: private
      cidrs: ["172.28.0.0/16"]
```

#### Every public HTTPS host

`egress.allowPublicHttps: true` lets a Connection reach a host that no entry names, over `https` on port 443, for an instance whose administrators connect outside services themselves. The operator accepts that any administrator of the instance may then send a Connection, and its credential, to any public HTTPS service.

```yaml
egress:
  allowPublicHttps: true
  allow:
    - protocol: http
      host: mcp-internal
      port: 8080
      network: private
      cidrs: ["172.28.0.0/16"]
```

- Such a target is judged as a `public` entry: every address the host answers must be public. Loopback, link-local, cloud metadata addresses, private ranges and their IPv4-mapped IPv6 forms are refused as above.
- The instance's database host is refused on every port, by name and by address.
- Redirects and returned download addresses are checked as new targets, and the credential still goes only to the origin it was configured for.
- Another port, plain `http` and `postgres` still need an entry under `egress.allow`. The entries keep working beside the setting, and a private host is reached only through a `private` entry.
- A start with the setting on logs a warning once.

#### Refusals

A refusal answers `egress_denied` with the host and the port, and nothing else of the address. Its message ends with the setting that would let the target through: an entry under `egress.allow`, `egress.allowPublicHttps` for `https` on port 443, a `private` entry for a host that resolves to a private address, or that no setting does, as for a link-local address or the database host. A target outside the list is refused before its name is looked up. A host that is on the list and whose name gives no address, as with a stopped service or a resolver that is down, is refused as well and nothing is contacted, but it is not `egress_denied`: a call answers `connection_unavailable` and says that the host did not resolve, and a test of the Connection answers `unavailable`. A checked answer is used for 30 seconds, so a call within that time makes no DNS lookup, and a page load makes none at all. A refusal that came from the resolver (a timeout, a failed lookup, no answer) is held for 5 seconds. The list and `allowPublicHttps` are read at start: a change needs a restart.

## Data Stores

With the module `dataStores` on, each Data Store gets a Postgres database of its own on the server of the platform database. The module needs a key under `secretStore.keys`, where the passwords of the store roles are kept, and a platform database role that has `CREATEDB` and `CREATEROLE` and owns the platform database.

```yaml
dataStores:
  sizeLimit: 5GB
  poolMaxConnections: 5
```

- `sizeLimit` is the most one store may hold, as a whole number of `MB` or `GB`. A store's own `sizeLimit` in `store.yaml` names less and never more. At the limit no rows are added and reading keeps working. Every insert reads the size of the database before it writes and after, and is rolled back where it passed the limit: no row that is kept lies beyond it, and the files exceed it only by what the inserts of one moment wrote, under 256 MiB for rows alone. Default `5GB`.
- `poolMaxConnections` is the most connections one process holds to one store at once, between 1 and 10. Default 5.

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
