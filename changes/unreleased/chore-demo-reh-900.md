---
section: Changed
---

- The demo client turns on the Data Stores module, so a Workflow can load findings into a store and an App can read them with `sql` actions.
- The demo's Compose file passes the sample accounting server's REST fault switches and volume divisor from `clients/demo/.env`, all off unless set. An empty `SAMPLE_ACCOUNTING_REST_UNAVAILABLE_CLIENT_ID` now means off instead of failing the sample server's start.
