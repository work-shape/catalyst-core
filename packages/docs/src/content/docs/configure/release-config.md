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
- capability activation and settings
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

administration:
  agentConfiguration:
    enabled: true
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
  conversations:
    deleteAfterDays: 90
  audit:
    deleteAfterDays: 730

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

The conversation Resources panel is enabled by default and appears only after a user enters a persisted Conversation. Set `ui.resources.enabled: false` only when a deployment must opt out of that surface.

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

Checks run concurrently when a request is created. For skill changes, the summary and proposed new text are sent to the configured model provider; existing skill text and replaced text are excluded. Select a provider and binding approved for that content. Checks use the instance's usage budgets and safeguards, with usage recorded against the originating conversation and run when available.

`warn` stores a visible warning and leaves the decision with the approver. `block` refuses a violating proposal and returns the reason to the agent without storing a request. If a check cannot be evaluated, including provider failures or the 10-second timeout, `warn` stores a neutral warning and `block` refuses the proposal, so a blocking rule never lets unchecked content through. Checks are not repeated when a request is decided. Request kinds without a proposed-content extractor are not checked.

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

OpenAI-compatible providers keep API-specific request shapes behind the model-provider boundary. Agents and tools still see Vivd Catalyst's provider-neutral messages, tools, tool calls, tool results, and usage.

Use `api: responses` for OpenAI reasoning models that combine reasoning, tool calling, or multi-turn workflows. Leave the field unset, or set `api: chat_completions`, for legacy OpenAI-compatible endpoints that still expect `/chat/completions`.

```yaml
modelProviders:
  - id: openai
    type: openai-compatible
    api: responses
    model: gpt-5.5
    reasoningEffort: high
    baseUrl: https://api.openai.com/v1
    apiKeyEnvName: OPENAI_API_KEY
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
  Unset, a binding on an `openai-compatible` provider offers `low`, `medium`, `high`, `xhigh`
  and `max`. Catalyst passes the pick to the provider unchanged, so list fewer for a model
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

The EU mark is shown for models whose provider declares `compliance.residency: eu`.

A model or effort a user picks becomes their own default for new conversations and is stored
with their account, so it follows them across devices. A conversation that already ran stays on
what its latest run used. A user who never picked anything follows the agent's configured model
and effort, so a change to those defaults still reaches them.

## Mail

Mail is off by default. Enabling it adds a forgot-password link to the login panel and lets user
administrators email a set-password link instead of sharing an initial password. Both need
standalone auth.

```yaml
mail:
  enabled: true
  provider: mailjet
  apiKeyEnvName: MAILJET_API_KEY
  apiSecretEnvName: MAILJET_API_SECRET
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
- Startup fails when mail is enabled and either named environment variable is missing.
- `provider: capture` keeps mails in memory and lists them at `GET /api/dev/captured-mail`.
  That route needs no sign-in, so only `environment: development` config accepts it; staging
  and production config reject it.

Reset links are valid for 60 minutes and invitation links for 7 days. A link stops working once
it is used, once a newer link is issued, or once the password changes another way. A reset
request therefore also replaces a pending invitation link for the same user. Reset
requests always get the same answer, whether or not an account exists, and are limited to three
per address per hour.

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
