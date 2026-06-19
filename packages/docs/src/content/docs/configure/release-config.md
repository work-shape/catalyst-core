---
title: Release Config
description: Use source-controlled config as the source of truth for instance behavior.
---

Release config defines what a client instance does. It is version-controlled, validated at startup, and deployed with the client assembly app.

V1 does not rely on runtime mutation for agent behavior, tool availability, model providers, UI settings, or retention policy.

## What Release Config Owns

Release config should cover:

- agents and instructions
- client skill files and agent skill allowlists
- tool enablement, tool parameters, and agent tool allowlists
- model provider choices
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
clientInstance:
  id: example-support
  displayName: Example Support Chat

agents:
  support_agent:
    displayName: Support Agent
    instructions: ./agents/instructions/support-agent.md
    tools:
      - support.lookup_ticket
      - support.create_escalation

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
    monthlySpendLimit: 200
    costSafetyMultiplier: 1.3
  safeguards:
    modelCallsPerDay: 1000
    tokensPerDay: 2500000
```

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

## Client Skills

Client skills are source-controlled Markdown guidance documents. Release config lists skill files explicitly, and each agent allowlists the skills it may read.

```yaml
skillFiles:
  - ../skills/support-review/SKILL.md

agents:
  - name: support_agent
    skillNames:
      - support_review
    toolNames:
      - read_skill
      - support.lookup_ticket

tools:
  - name: read_skill
    enabled: true
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

## UI Branding

The platform shell provides `/favicon.svg` as the default favicon. Set `ui.faviconUrl` when a client needs its own icon; the value may be an absolute URL or a root-relative path served by that client.

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
```

## Config Is Not A Secret Store

Release config may reference secrets, but it must not contain secret values.

Use runtime env files or a secret manager for:

- model provider API keys
- database passwords
- customer API credentials
- object storage credentials
- server-to-server token exchange credentials

## Change Flow

Treat config changes like code changes:

```text
edit config
  -> validate assembly
  -> run tests
  -> build image
  -> deploy explicit version
  -> record active config version
```

The control plane may display active config and snapshots. It should not silently change agent behavior in production.
