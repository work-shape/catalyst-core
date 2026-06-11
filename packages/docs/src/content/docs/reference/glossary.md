---
title: Glossary
description: Core terms used by the operator documentation.
---

## Customer

An organization that uses the agent chat platform for its own internal users and domain workflows.

## User

A person authenticated by a customer application or standalone login path who may interact with the chat.

## Client Instance

A separately deployed product instance for one customer, with its own infrastructure and operational boundary.

## Instance Operator

The party responsible for running a client instance. This may be us or the customer.

## Operated Dedicated Instance

A dedicated instance hosted and maintained by an operator for one customer.

## Self-Operated Instance

A dedicated instance run by the customer in its own infrastructure or chosen hosting environment.

## Customer-Hosted Integration

A customer system, API, MCP server, or data source that a client instance calls but does not operate.

## Client Assembly App

The TypeScript application that imports platform packages, registers client tools, loads release config, and builds the deployable client-specific server image.

## Release Config

Version-controlled configuration deployed with the client assembly app. It defines agent behavior, tools, model provider options, UI settings, retention, usage policy, and related instance settings.

## Agent

A configured AI behavior with instructions, model settings, available tools, and optional knowledge sources.

## Custom Code Tool

A tool implemented with customer-specific code that runs inside the client instance or one of its execution runtimes.

## OpenAPI API Tool

A tool configured from a selected OpenAPI operation whose backing API runs outside the product.

## Embed Surface

The customer-facing integration point that renders chat inside a customer application.

## Conversation

A persisted chat history owned by an authenticated user and retained according to the client instance retention policy.

## Audit Event

A minimized governance record of a security, data, tool, config, or lifecycle action. It is not a full transcript.
