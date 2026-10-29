---
section: Changed
---

- **Usage limits and Workflow runs:** A Workflow run that a spend or safeguard limit stops ends `limit_reached` instead of `failed`, whether the limit refused an agent step or a model call made inside an operation step. Its error is `MODEL_USAGE_LIMIT_REACHED` and carries `usageLimit` (`period`, `metric`, `scope`). The run page names the limit, when it resets and who can raise it, in English and German. The publisher is told by Inbox, as for any run that ends at a limit.
- **Usage limits and App actions:** A Page or App whose action is refused at a usage limit gets `limit_reached` as the `callFailure` code, with a sentence in the viewer's language and no offer to try again. See the App bridge reference.
- **Usage Breakdown:** A model call made inside an operation that a Workflow step ran now counts to that Workflow, so the Breakdown's Workflow rows and the Workflows origin hold it. The reconciliation job re-keys the daily sums once on the first start of this release; no migration is needed.
