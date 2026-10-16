---
section: Fixed
---

- Isolate browser Connection editor and page-frame fixtures from instance-wide Connection list and principal rights checks, verify cleanup succeeds, and diagnose abandoned holders without capping healthy lock queues. Keep page-frame lock waits outside test timeouts, after the App build. Serialize the sidebar rights writer and revoke its grant during cleanup.
