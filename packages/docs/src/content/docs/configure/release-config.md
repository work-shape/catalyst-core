---
title: Release Config
description: Use source-controlled config as the source of truth for instance behavior.
---

Release config defines what a client instance does. It is version-controlled, validated at startup, and deployed with the client assembly app.

V1 does not rely on runtime mutation for agent behavior, tool availability, model providers, UI settings, or retention policy.

## What Release Config Owns

Release config should cover:

- agents and instructions
- tool enablement and agent tool allowlists
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
