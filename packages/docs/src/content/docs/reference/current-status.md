---
title: Current Status
description: What exists now and what is still a target shape.
---

Vivd Catalyst is early. These docs describe the intended product model and the current repository shape, not a finished commercial platform.

## Implemented Or In Progress

The repository currently contains:

- reusable platform packages under `packages/`
- a demo client assembly app under `clients/demo/`
- schema-owned API contract and API client packages
- chat server package
- standalone chat UI package
- shared chat UI package
- tool SDK and tool execution packages
- config schema package
- capability SDK package with capability authoring contracts and Managed Object Access
- auth package
- Postgres store package
- datasource registry package with guarded Postgres query access
- usage governance package

Workspace-level planning docs and ADRs live outside the OSS platform repo while
the product is still being split into platform, capability, and deployment
repositories.

The current implementation includes a local vertical slice for the demo client.

## Still Stabilizing

Expect changes around:

- exact client assembly API shape
- release config schema details
- production deployment scripts
- generated API client flow
- OpenAPI tool adapter implementation
- file acquisition and restricted document processing packages
- approval-required tool resume flow
- deeper worker isolation
- self-hosted production runbooks

## How To Use These Docs Today

Use them as the operator and integrator documentation skeleton.

When implementation details change, update these pages so the docs stay aligned with the actual package boundaries and deployment contract.
