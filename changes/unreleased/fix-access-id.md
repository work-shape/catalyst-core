---
section: Fixed
---

- Retained Workflow runs keep their asset authorization identity after deletion, so asset denies still apply and permitted readers retain access.
- Workflow needed rights carry the owning workspace through derivation and evaluation.
- Operations declaring a required right resolve incomplete asset resources before authorization, including paged and resumed calls; unresolvable registered assets fail closed. Custom operation execution integrations must provide `RunOperationDeps.resolveResource`; server assemblies supply it.
