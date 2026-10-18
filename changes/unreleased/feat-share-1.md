---
section: Added
---

- **App sharing:** Apps ask who may use a published revision: only its builder, its owning workspace, or the whole instance when the publisher has the instance publish right. The selected audience is stored in the existing availability and changes atomically with publication. A wider audience is held by the default publish guardrail; its Inbox review names the audience. Saving still asks nothing and offers Share beside the result.

- **CLI:** The CLI asks for the audience before its publish review. For unattended App publication, pass `--audience self|workspace|instance` with `--yes`; omitting it refuses with “Choose who may use the App with --audience self|workspace|instance. Nothing was published.” Existing published Apps keep their workspace audience. No database migration is required: a private audience selects the publishing person's existing personal workspace in availability. On rollback, the previous release does not enforce App availability; do not roll back while private published Apps exist.
