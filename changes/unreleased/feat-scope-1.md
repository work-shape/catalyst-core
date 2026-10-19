---
section: Added
---

- **Data scope:** Declare one text data scope in release config and assign values or all values on Instance > Access. Scoped Data Store tables declare `tables.<table>.scope.<dimension>: <column>` and require a text `NOT NULL` column. Preview, rows, individual values and simple table queries filter by the caller's assignment. Administrators have no implicit assignment. The App host and row preview explain missing assignments. A person's revocations take precedence over group allowances.

- **Data scope:** App SQL actions and Knowledge Base named queries bind `$viewer.scope('dimension')` and `$viewer.scope_all('dimension')` as server-owned parameters. Publish refuses a missing binding with `Action '<action>' reads scoped table '<table>' without $viewer.scope('<dimension>')`. Free SQL on scoped Knowledge Base tables is refused with `Free SQL on scoped tables is refused. Use a published named query.` Inserts and loads refuse missing scope values; scoped mutations check old and new values. Declare assignments before enabling scoped tables. Rolling back to an older application removes these guards and requires restricting the store's audience first.
