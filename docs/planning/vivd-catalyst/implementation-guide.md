# Implementation Guide

This guide describes how implementation work should be approached once code is added.

## Code Quality

Code should be concise, readable, and explicit about the product concepts it implements. Prefer deep modules: small interfaces that hide meaningful behavior and give callers real leverage.

Implementation rules:

- Prefer an essential implementation: hide complexity behind focused interfaces and strong defaults.
- Keep platform modules separate from client-specific code.
- Keep client assembly apps thin.
- Use product-owned types at public package, SDK, API, config, persistence, and inter-package contracts.
- Keep third-party framework types inside adapters or implementation details.
- Avoid pass-through modules that only rename another module's interface.
- Avoid broad abstractions unless tied to a concrete extension, deployment, or testing need.
- Do not add fields, config knobs, UI controls, or packages unless they are required by the current workflow or an accepted interface boundary.
- Split large files by concern before they become hard to navigate.
- Treat 1000+ line source files as architectural friction unless they are generated or have a strong reason to stay together.
- Prefer locality: changes to one product concept should usually live in one module or package area.
- Keep interfaces honest: include invariants, error modes, ordering, cancellation, timeouts, authorization context, and configuration expectations where they matter.
- Use current stable dependency versions at implementation time.

## Architecture Review Loop

During implementation, periodically use:

```text
.agents/skills/improve-codebase-architecture/SKILL.md
```

Use it when:

- a package boundary starts feeling noisy
- a module becomes a pass-through
- a file grows large because multiple concerns are mixed together
- understanding one concept requires jumping through many files
- tests are only possible by reaching into implementation details
- tool execution, agent runtime, auth, storage, or UI output code starts leaking across seams

The goal is not to refactor constantly. The goal is to keep the codebase AI-navigable and testable as the platform grows.

Use the skill vocabulary when reviewing implementation:

- **Module**: anything with an interface and implementation.
- **Interface**: everything callers must know to use the module.
- **Implementation**: code inside the module.
- **Depth**: leverage at the interface.
- **Adapter**: concrete implementation satisfying an interface.
- **Locality**: related knowledge and change concentrated in one place.

Apply the deletion test to suspicious modules: if deleting the module makes complexity vanish, it was likely shallow; if deleting it spreads complexity across callers, it was earning its place.

## Testing Philosophy

Test coverage percentage is not the goal. Meaningful verification is the goal.

Prefer tests that exercise stable interfaces and real workflows:

- integration tests for API routes, auth handshake behavior, database writes, config loading, and tool execution
- end-to-end tests for standalone chat and embedded-widget flows where practical
- contract tests for generated API clients and public package interfaces
- tool tests that verify schemas, authorization context, error handling, timeouts, and audit records
- migration tests or migration smoke checks for Postgres
- deployment smoke tests for Compose health checks

Avoid tests that only lock down incidental implementation details. If a module is hard to test without reaching into internals, treat that as architecture feedback.

## Implementation Checkpoints

Before merging substantial implementation work, ask:

- What can be hidden, defaulted, or removed so the workflow is clearer?
- Does this keep platform code reusable?
- Is customer-specific code still a thin layer?
- Are files split by concern and kept navigable?
- Is the interface smaller than the behavior it hides?
- Are errors, cancellation, timeouts, and authorization context explicit?
- Does this preserve the code-deployed model?
- Does this avoid managed multi-tenant SaaS assumptions?
- Is there at least one meaningful test for the behavior or workflow changed?
- Would `improve-codebase-architecture` flag this as shallow or hard to navigate?
