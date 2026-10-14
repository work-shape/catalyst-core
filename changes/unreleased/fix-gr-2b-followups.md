---
section: Fixed
---

- **Guardrails on UTF-16 without a mark and on the App draft of a `page.save`:** a file is now
  read as UTF-16 without a byte order mark where at least 90% of the bytes at one parity of its
  first KiB are NUL and at most 10% at the other. Before, it took a NUL in every other byte, so
  one letter outside Latin-1, as in "Łukasz", left the file printable runs and an IBAN in it
  passed. A guardrail that warns about the App draft a `page.save` writes is now passed on to
  the agent (`app.warnings` of the answer). One that asks for an approval there blocks the draft,
  as no request is filed and nobody could approve it; the answer says that the person's Update
  app on the Page can wait for the approval. Its hit is kept as a `block` that says it answered
  a request for an approval (`convertedFrom: require_approval` of `guardrails.list_hits`), and
  the guardrail's page shows it as "Blocked: approval could not wait".
