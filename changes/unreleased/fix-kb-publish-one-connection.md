---
section: Fixed
---

- Publishing more Knowledge Bases at once than the platform database pool has connections no longer stalls every publish. A publish on a Data Store read the store, the store's role passwords and, when it opened a connection as a store role, that role's password through a second connection of the pool while its own transaction held one. With every connection held by a waiting publish, none could go on. Every one of those reads now goes through the publish's transaction, as does the removal of such a Knowledge Base and the processing review of a republished Knowledge Base with documents. A target of the Postgres executor may now name where the password of a connection it opens is read.
