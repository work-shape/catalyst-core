---
section: Added
---

- Personal Connection calls now require an owner-authorized agent run in a conversation only that owner can read. Workflow steps, App actions, delegated sessions, API keys and outside clients are refused before a credential is resolved. Subagents inherit their root chat's privacy; authorized scheduled starts use their owner's binding while signed out.
- A conversation's first personal call permanently marks it, including failed calls. Marked conversations cannot widen their readers through a move, visibility change or feedback transcript copy. Agent-origin changes outside the owner's personal Connections require at least confirmation.
- Personal Operation Runs retain outcome, input hash, timing and result byte count, with no input reference or output. Completed results cannot be replayed from the run; recovery after a worker completed a confirmed call returns completion metadata only. Personal calls that would freeze input in an approval or Inbox item are refused; conversation confirmations retain no input reference on the Operation Run.
