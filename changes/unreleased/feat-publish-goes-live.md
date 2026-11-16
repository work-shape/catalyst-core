---
section: Changed
---

- **A publish goes live directly:** a holder of the publish right makes an App, a Workflow, a
  form page, an agent or a skill live at once, from Studio, `catalyst <kind> publish` or
  `catalyst config push --publish`. The shipped guardrail "Publishing needs an instance admin's
  approval" is off by default; an instance admin can switch it on on Build > Guardrails, and a
  guardrail an instance binds to a `*.before_publish` event still stops or holds a publish.
  Migration `0205_publish_guardrail_off_by_default` removes its stored switches, so every
  instance starts with it off, an instance where an admin had set "Ask on every publish"
  included. The CLI asks no question before a publish and never sends it unattended; `--yes` is
  accepted and changes nothing. Requests already waiting in an Inbox stay decidable and are
  settled as superseded once a newer revision goes live.
- **Skill changes from chat:** a person who holds `skill.publish` on a skill accepts the change
  their agent proposed for it on the card in the chat, and it is live at once without a second
  person. The card under a waiting skill change says it is not live yet and who makes it live.
