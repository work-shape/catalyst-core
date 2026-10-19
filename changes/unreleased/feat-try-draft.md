---
section: Added
---

- **Agent Try:** Try runs a frozen snapshot of the agent's shared draft, or its published version when no draft exists. Each turn records the revision; usage belongs to the person trying and is tagged preview. Preview omits platform asset tools and skill change proposals. Reading calls use the person's rights and changing calls simulate what would have happened, with the draft provenance on the Operation Run and no Run live once, including Workflow test targets started from Try. Moving a Try conversation is refused with "A preview conversation stays with its agent". Rollback does not remove stored preview transcripts or usage.

- **Preview rollout:** Apply migrations, deploy the new Agent Run workers and fully drain the old workers before exposing the new Try API. Old workers cannot enforce preview isolation. An old queued Try turn without a valid snapshot now fails with "The preview snapshot is not available. Send the message again in Try." instead of running the published agent. Retry the turn in Try after upgrading.
