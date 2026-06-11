---
title: Instance Brief
description: The thin documentation every client instance should have before implementation.
---

Write a short instance brief before configuring a client instance.

This is not a long specification. It is the minimum shared context that keeps tools, prompts, auth, retention, and deployment choices aligned.

## Template

```md
# Instance Brief

## Purpose

What should this chat help users accomplish?

## Users

Who can use it? Which roles or permission refs matter?

## Operating Model

Who operates the dedicated instance?

- operated dedicated instance
- self-operated instance
- mixed, with customer-hosted integrations

## Data

Which sensitive data can enter the chat?

Which data must never enter the chat?

## Agent

What should the agent do?

What should it refuse or escalate?

Which language or tone constraints matter?

## Tools

List each proposed tool:

- stable tool name
- purpose
- source system
- read or write action
- required permission
- expected audit summary
- output shown to the model
- output shown to the user

## Chat Experience

Branding, welcome text, suggested prompts, locales, and domain UI outputs.

## Auth And Access

How does an authenticated user reach the chat?

How are roles or permission refs mapped?

## Retention And Deletion

Conversation retention, audit retention, backup retention, and deletion expectations.

## Model Provider

Provider, model, region, budget, and external billing controls.

## Deployment

Runtime owner, target environment, database, object storage, proxy/TLS, monitoring, and backup owner.

## Open Questions

Anything that must be answered before production use.
```

## Keep It Current

Update the brief when the workflow scope changes, not for every code detail.

Implementation choices belong in release config, tool code, planning docs, or ADRs. The brief exists so everyone can understand the instance boundary quickly.
