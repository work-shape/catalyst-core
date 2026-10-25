---
section: Changed
---

- **Data Stores:** A correction in "Review" (German "Prüfen") no longer writes over what the document reads. The candidate keeps the value read, with its page, quote and evidence, and the person's value stands beside it. "Review" shows a corrected candidate as "Read" and "Corrected" (German "Gelesen" and "Korrigiert"), with who corrected it and when. Replacing a correction with another decision drops the person's value, and the candidate counts again as what its document reads, with its evidence as checked; it is no longer marked as not holding until the document is read again. The customer's table still holds only the winning value, and the audit event `data_store.record_decided` still holds no value.
- **Data Stores:** `records.flagged` and `GET /api/v1/data-stores/:store/records/flagged` give each candidate `correctedValue`, the person's value, set while its state is `corrected` and `null` otherwise; `value` is what the document reads. `catalyst data-store review list` prints both.
