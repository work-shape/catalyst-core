---
title: Glossary
description: The terms these docs and the interface use, with the German screen names.
---

## Customer

An organization that uses the agent chat platform for its own internal users and domain workflows.

## User

A person authenticated by a customer application or standalone login path who may interact with the chat.

## Client Instance

A separately deployed product instance for one customer, with its own infrastructure and operational boundary.

## Instance Operator

The party responsible for running a client instance. This may be Workshape or the customer.

## Operated Dedicated Instance

A dedicated instance hosted and maintained by an operator for one customer.

## Self-Operated Instance

A dedicated instance run by the customer in its own infrastructure or chosen hosting environment.

## Customer-Hosted Integration

A customer system, API, MCP server, or data source that a client instance calls but does not operate.

## Client Assembly App

The TypeScript application that imports platform packages, registers client tools, loads release config, and builds the deployable client-specific server image.

## Release Config

Version-controlled configuration deployed with the client assembly app. It sets what needs a deployment to change: modules, model providers and bindings, tool enablement, the guardrail floor, Connections from config, egress, retention, usage policy, mail and infrastructure. Agents, skills, Apps, Workflows and guardrails written as assets are not in it; they live in the database and change at runtime.

## Module

One optional feature of the product with one switch in release config, `modules.<name>.enabled`, such as `apps`, `workflows` or `connections`. The interface lists them under **Settings > Instance > Modules** (German: **Module**). Planning documents call the same thing a Package (German: Paket); that name is not in the interface yet. See [Modules](/configure/modules/).

## Workspace

The place conversations, Apps and other work belong to, and whose members may reach them. Every person has a **Personal workspace** (German: **Persönlicher Arbeitsbereich**) that only they see. A **Shared workspace** (listed under **Geteilte Arbeitsbereiche** in German) has members, and its owners manage them under **Settings > Workspace**. Planning documents call it a Collaboration Workspace. It is not an Execution Workspace, which is the sandboxed folder an agent runs commands in.

## Studio

The area of the interface where builders make and look after agents, skills, Connections, Data Stores and guardrails. It has the same name in German. Only a person who may read one of these sees it.

## Agent

A configured AI behavior with instructions, model settings, available tools, and skills. Agents live in the database and are edited in Studio or with the CLI.

## Skill

Instructions an agent reads when a task calls for them, as a folder with a `SKILL.md` and optional files. Some skills ship with the platform and are read-only; **Copy to edit** makes an editable copy.

## Page

What an agent builds in one conversation and shows beside the chat: screens with their files, without a name or a history of its own. **Save as app** (German: **Als App speichern**) turns it into an App.

## App

Screens plus named actions that work with data outside a chat, saved in a workspace. An App has a draft and a published revision: members of the workspace see the published one, and changing actions in the draft are only simulated, unless a person who may edit the App uses **Run live once** (German: **Einmal live ausführen**) for one call. See [Build an App](/apps/build/).

## Workflow

A fixed sequence of steps the platform runs without a conversation, started by hand or on a schedule. It acts as one service principal, whoever starts it. A Workflow is drafted, tried with a test run and published. It has its own row in the main rail, **Workflows**.

## Connection

The access to one outside system, today always a remote MCP server. It holds the address and, stored encrypted, one key for everyone who may use it. Agents call the operations it offers once a person has accepted them. In the interface: **Studio > Connections** (German: **Studio › Verbindungen**).

## Data Store

A SQL database the platform hosts for Apps and Workflows, one per store, changed only through the migrations of its definition. In the interface: **Studio > Data stores** (German: **Datenspeicher**).

## Guardrail

A rule that checks an action just before it happens, such as saving an asset, calling an operation or publishing an App, and answers allow, warn, ask for an approval, or block. The operator's floor comes from release config; further guardrails are written as assets and published. In the interface: **Studio > Guardrails** (German: **Studio › Leitplanken**). See [How rights work](/operate/how-rights-work/#guardrails).

## Inbox

Where requests for approval wait: skill changes an agent proposes, and calls that the policy or a guardrail holds. German: **Eingang**. A person who may decide sees **To decide** (**Zu entscheiden**) and **Decided** (**Entschieden**); everyone else sees their own requests.

## Custom Code Tool

A tool implemented with customer-specific code that runs inside the client instance or one of its execution runtimes.

## Embed Surface

The customer-facing integration point that renders chat inside a customer application.

## Conversation

A persisted chat history owned by an authenticated user and retained according to the client instance retention policy.

## Audit Event

A minimized governance record of a security, data, tool, config, or lifecycle action. It is not a full transcript.
