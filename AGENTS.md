# AGENTS.md

## Project Purpose

This repo is planning and eventually implementing a reusable AI agent chat platform for sensitive customer workflows.

`Data Chat` is a working title. Do not treat it as a final brand, package scope, or product boundary.

## Start Here

- Read `CONTEXT.md` first for project terminology.
- Read `docs/planning/agent-chat-platform.md` before changing architecture or scope.
- Read the relevant focused planning file under `docs/planning/agent-chat-platform/` before implementing or reviewing a feature.
- Read `docs/planning/agent-chat-platform/implementation-guide.md` before implementation work.
- Read `docs/research/open-source-landscape.md` before choosing AI SDKs, agent frameworks, chat UI libraries, MCP libraries, auth libraries, or comparable platform dependencies.
- Read `application-preprocessing-compliance-analysis.md` when working on compliance, privacy, provider choice, or sensitive document processing.

## Working Rules

- Treat this as a product foundation, not a one-off customer app.
- Keep project decisions in planning docs or ADRs, not in `AGENTS.md`.
- Prefer an essential design: hide complexity behind strong defaults and expose only the fields, settings, UI controls, and extension points that the workflow truly needs.
- Keep platform code reusable and client-specific code thin.
- Keep customer-specific labels, prompts, tool names, examples, and workflow copy out of `packages/*`; put them in `clients/*`, fixtures, release config, or agent config.
- Prefer narrow, documented extension surfaces over ad hoc code paths.
- Do not add broad abstractions unless tied to a concrete extension, deployment, or testing need.
- Do not add knobs because they might be useful later; make release config and UI surfaces earn every field.
- Keep third-party framework types inside adapters or implementation details; public boundaries should use product-owned types.
- For sensitive data flows, document retention, audit, authorization, and provider-region assumptions before implementation.
- Treat audit as minimized governance events, not full payload logging.
- Build meaningful tests around stable interfaces and workflows; coverage percentage is secondary.
- Split large source files by concern; treat 1000+ line non-generated files as architecture friction unless there is a strong reason.
- Use `.agents/skills/improve-codebase-architecture/SKILL.md` periodically during implementation to find shallow modules and deepening opportunities.

## Documentation Rules

- Update `CONTEXT.md` only when project terminology is clarified.
- Keep `CONTEXT.md` as a glossary only; implementation decisions belong in planning docs or ADRs.
- Use `docs/planning/agent-chat-platform.md` as the planning index and decision map.
- Add ADRs only for hard-to-reverse architecture decisions with real trade-offs.
