---
section: Database
---

- **Models:** Migration `0151_model_provider_continuation_message_indexes` indexes the message each stored provider continuation came with, in `model_provider_continuations` and `model_provider_turn_continuations`. Deleting a conversation's messages removed their continuations by reading the whole table once per message. The indexes are built concurrently and move no data; the migration can run while the previous release serves.
