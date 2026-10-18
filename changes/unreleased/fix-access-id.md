---
section: Fixed
---

- Retained Workflow runs keep their asset authorization identity after deletion, so asset denies still apply and permitted readers retain access.
- Workflow needed rights carry the owning workspace through derivation and evaluation, and retain asset denies on deleted children at publish.
- Operations declaring a required right resolve incomplete asset resources before authorization, including paged and resumed calls; unresolvable registered assets ask the kind-level right, answering the same 403 as no grant or 404 for authorized callers without executing. Custom operation execution integrations must provide `RunOperationDeps.resolveResource`; server assemblies supply it.
- Operation listings and App action checks resolve declared resources through the same identity lookup as direct calls.
