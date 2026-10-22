---
section: Database
---

- **Conversations:** Migration `0142_conversation_creation_target` adds the nullable column `conversations.creation_target`, which holds only `instance` or nothing. Existing conversations keep nothing and behave as before. It moves no data and waits at most 5 seconds for its lock. Apply it before starting the new API. The previous release does not read the column, so after a rollback of the application a chat started under Instance creates in its workspace again; remove the column only through a later committed migration.
