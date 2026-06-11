---
title: Run Vivd Catalyst
description: Configure, extend, and operate a dedicated AI agent chat instance.
---

Vivd Catalyst is a reusable AI agent chat platform for sensitive workflows.

The platform is not a shared marketplace and not a forkable one-off app. Each organization runs through a dedicated client instance assembled from reusable platform packages, release config, and a thin layer of customer-specific code.

Use these docs when you want to:

- configure a chat experience for your own organization or project
- write custom tools that let the agent act in your systems
- embed chat inside an existing application
- run the instance yourself or have an instance operator run it for you
- keep retention, audit, auth, and provider-region decisions explicit

## The Small Surface You Own

A client instance should stay thin:

```text
your-client-instance/
  agents/        # agent instructions and tool allowlists
  config/        # release config, UI text, retention, usage, providers
  tools/         # customer-specific tool implementations
  src/           # assembly code that imports platform packages
  deploy/        # env examples, compose overrides, proxy config
```

Most product behavior should come from platform packages. Your layer should describe what the agent is allowed to do, how the chat should appear, which systems it can call, and how the instance is operated.

## First Decisions

Before writing tools or deploying anything, decide:

- who operates the instance
- what the agent is allowed to help with
- which users may access it
- which customer systems and documents it may touch
- what should be retained, audited, deleted, and backed up
- which model provider and region are acceptable

Start with [Operating Models](/getting-started/operating-models/) and then write the [Instance Brief](/operate/instance-brief/).
