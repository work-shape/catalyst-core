---
section: Database
---

- **Models:** Migration `0150_model_provider_turn_continuations` adds the table `model_provider_turn_continuations`. It holds one row per conversation and model provider: the encrypted provider state the conversation's last finished run ended with, the model it was made on, and the message it was stored with. The row is removed with the conversation, with that message, and when the provider refuses it. It is created empty and moves no data. Apply it before starting the new API and worker. The previous release does not read the table; remove it only through a later committed migration.
