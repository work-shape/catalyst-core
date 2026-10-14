---
section: Added
---

- **Draft safe mode for Apps (ADR-0031):** a changing action called from the draft of an App is
  simulated: it answers `dry_run` with what it would have done and the input, changes nothing,
  and leaves an Operation Run with the target `dry_run` (named in `Operation-Run-Id`). A reading
  action reads live. "Run live once" on the Actions side of the draft carries out the next call
  of one changing action, for a person who writes the App. The switch is its owner's, on the
  key of action and person that Workflow test runs brought, so one member's switch neither
  replaces nor uses another's; the call goes through central policy (a call that needs another
  person's approval is refused with `approval_unavailable`, since a draft cannot wait). A save
  or a discard of the draft clears an unused switch at that moment and audits
  `live_once.cleared` in the name of who saved or discarded. `apps.actions.list` gives each
  action of a draft the `target` the reader's next call goes to. The test dialog says what the
  call would have done in the interface's language, and focus moves to the status line of
  "Run live once" once it is set. The UI library adds `TargetBadge` (Live, Test, Simulated),
  which now also marks the steps of a Workflow run, and `RunLiveOnce`. No migration of its
  own. A Page and a direct Connection call from a draft still refuse a
  changing call with `draft_safe_mode`. **Upgrade:** an App's draft that called a changing
  action got `409 draft_safe_mode` and now gets a `dry_run` answer; the call needs an
  `Idempotency-Key` as in a published App. **Rollback:** the previous release refuses such a
  call again; switches stay in `live_once_switches` and are cleared by the next save or call.
