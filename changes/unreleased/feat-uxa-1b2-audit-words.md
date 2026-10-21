---
section: Changed
---

- The Audit page says each activity, event, target and reason in English and German words (UXA-1b2), not in the server's English labels, event types or reason codes. An activity of `GET /api/v1/instance/audit-activities` now carries the `type` of the event that titles it and, for a tool's event, its `action`, in place of the English `label`; the words live in the interface catalogs, keyed by event type. A type or reason without words reads "Other activity" or "No description for this reason.", never the code. Every audited event of the event registry has words in both catalogs, and the plain-words test renders the German audit view and refuses event types and codes in it.
