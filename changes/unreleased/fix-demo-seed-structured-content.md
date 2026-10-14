---
section: Fixed
---

- **The demo's seeded Customers App and accounting Workflows read the Connection's rows:** the
  App `customer-list` and the Workflows `accounting-clients` and `kai-client-years` read the rows
  of an MCP Connection under `structuredContent`, where the Connection answers them. Before, the
  App showed "The customers could not be loaded." and both Workflows failed their loop as
  `reference_unresolved`. Revision 1 of each is changed in place, so a local demo database seeded
  before this fix needs a fresh seed.
