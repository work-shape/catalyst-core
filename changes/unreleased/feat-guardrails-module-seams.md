---
section: Changed
---

- Guardrails are a module, `modules.guardrails`. Off, their operations answer 404 `module_off`, the `guardrail` asset kind and its rights are gone, release guardrails are not seeded, and every before-event allows: only policy, floors and rights decide. For one transition release a config without the switch keeps guardrails on, so an upgrade to a build without their code refuses to start instead of dropping them quietly.
- A release config that sets `guardrails` while the module is off is refused at load, naming them.
- A check that throws or does not answer within 75 seconds refuses the action with `GUARDRAIL_BLOCKED` and the new error detail `details.reason: "check_unavailable"` (`details.guardrailId` then names the event). Before, a throwing check failed the call as `INTERNAL`. API change: the error description of `GUARDRAIL_BLOCKED` in the OpenAPI document, and `reason?: "check_unavailable"` on the guardrail denial of an operation result.
