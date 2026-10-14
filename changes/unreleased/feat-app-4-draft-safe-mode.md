---
section: Added
---

- **Draft safe mode for Apps (ADR-0031):** a changing action called from the draft of an App is
  simulated: it answers `dry_run` with what it would have done and the input, changes nothing,
  and leaves an Operation Run with the target `dry_run` (named in `Operation-Run-Id`). A reading
  action reads live. "Run live once" on the Actions side of the draft carries out the next call
  of one changing action, for a person who writes the App; only that person's next call uses
  it, the call goes through central policy (a call that needs another person's approval is
  refused with `approval_unavailable`, since a draft cannot wait), and the next save of the
  draft clears a switch not yet used. `apps.actions.list` gives each action of a draft the
  `target` the reader's next call goes to. The UI library adds `TargetBadge` (Live, Test,
  Simulated) and `RunLiveOnce`. A Page and a direct Connection call from a draft still refuse a
  changing call with `draft_safe_mode`. **Upgrade:** an App's draft that called a changing
  action got `409 draft_safe_mode` and now gets a `dry_run` answer; the call needs an
  `Idempotency-Key` as in a published App. **Rollback:** the previous release refuses such a
  call again; switches stay in `live_once_switches` and are cleared by the next save.
