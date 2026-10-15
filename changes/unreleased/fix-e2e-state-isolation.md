---
section: Fixed
---

- Isolate browser Connection editor and page-frame fixtures from instance-wide Connection list and principal rights checks, verify cleanup succeeds, and cap lock queue waits at five minutes with holder diagnostics. Serialize the sidebar rights writer and revoke its grant during cleanup.
