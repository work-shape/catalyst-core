---
title: Operating Models
description: Choose whether the dedicated instance is operated for you or by you.
---

Every Vivd Stage deployment is a dedicated client instance. The main decision is who operates it.

## Operated Dedicated Instance

Use this when a team wants the chat outcome but does not want to run infrastructure.

The customer provides:

- the instance brief
- user and role expectations
- agent instructions and workflow examples
- custom tool requirements or tool code
- model provider and region constraints
- retention, deletion, and audit requirements
- branding and chat copy
- customer application integration details

The instance operator owns:

- Docker images and runtime services
- database, object storage, and backups
- reverse proxy and TLS
- migrations and deploy scripts
- health checks and incident response
- production env files and secret handling

This is often the right starting point. The customer still controls the workflow and sensitive-data assumptions, but does not need to become the platform operator.

## Self-Operated Instance

Use this when the customer needs direct operational control or wants to run the instance inside its own infrastructure boundary.

The customer owns both layers:

- client assembly code and release config
- tool implementations and integrations
- runtime infrastructure
- backups, monitoring, TLS, secrets, and restore drills
- provider contracts and region controls

The same platform package boundaries apply. Self-operation should not mean forking the platform.

## Customer-Hosted Integrations

Some systems remain outside Vivd Stage even when the instance is operated for the customer.

Examples:

- a customer API called by an OpenAPI API tool
- an internal document system called by a custom code tool
- a customer endpoint that exchanges an existing app session for a short-lived chat session token

These are customer-hosted integrations. They are not part of the Vivd Stage runtime, but the instance must document how it authenticates to them, what data it sends, and what failures look like.

## Choosing A Path

Choose operated dedicated instance when speed and low operational burden matter most.

Choose self-operated instance when infrastructure location, network boundaries, internal policy, or direct operational ownership matter most.

In both cases, write the [Instance Brief](/operate/instance-brief/) before implementation.
