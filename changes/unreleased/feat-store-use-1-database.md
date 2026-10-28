---
section: Database
---

- Migration `0169_conversation_data_stores` adds `conversation_data_stores`: one row per Data Store a person added to a conversation for reading, with the store's id, who added it and when. Rows go with their conversation, store or account. It is a new, empty table; no row is rewritten.
