---
section: Added
---

- Add `pnpm check:affected` for builders to check changed packages and their dependents before review, with package quality baselines and affected tests.
- Fall back to all scopes for shared quality tooling changes, type-check root tests for every selected package, keep root-test-only checks narrow, and include Git diagnostics for missing bases.
