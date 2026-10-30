---
section: Changed
---

- **Publish guardrail asks only when a publish widens reach (GR-PUB-2):** The shipped guardrail `publishing-needs-approval` now holds a new revision of an App or a workspace's agent for an instance admin only when it widens what goes live: a first publish, a new or changed changing action or operation, a new outside host, a Connection or Data Store the live revision does not use, a wider audience, or for an agent a new tool, skill, Knowledge Base, subagent or model. Otherwise the publisher's own click is enough. Workflows and form pages, and every publish whose reach cannot be computed, still ask.
- The check reuses the App publish review (SHARE-1, DS-13b) and the agent publish review (WS-PUB-1b). The reach the guardrail checked is the reach the publish commits, and the commit still rechecks the live revision and audience under its lock. The before-event carries `publish_widens`, which the audit of the hit records.
- An instance admin can switch the guardrail to ask on every publish (`alwaysAsk` on `guardrails.switch_shipped`, "Ask on every publish" in the Guardrails list). The switch is audited. Other shipped guardrails refuse it with `always_ask_unsupported`. `enabled` and `alwaysAsk` are each optional and each is written on its own, so switching one never changes the other; a call with neither is refused with `nothing_to_switch`.
- A personal API key acts as its person: its `assets.publish` without the `Catalyst-Unattended` header makes a version that widens nothing live at once. A call with the header is held in its person's Inbox.
- An agent's publish still pauses for its person's confirmation, whether or not it widens: every revision needs a person's click.
