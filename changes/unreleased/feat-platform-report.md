---
section: Added
---

- A run or a tool that fails for a platform reason offers "Problem an Workshape melden" in the conversation. A small dialog says what is sent (the run's id, the error code, the instance and the time; nothing of the conversation, its files or logs), takes an optional note and sends. `POST /api/v1/conversations/{conversationId}/runs/{runId}/platform-report` (`platform_report.send`) checks the failure again from the run's records and mails the release config's new `support.email` from the instance's own sender; Reply-To is the person only when they tick "Antwort an mich". One report per run and person, five per person an hour. The audit records `agent_run.platform_reported` with the run, the report and the code, never the note. Without `support.email` or mail the action is not shown.
