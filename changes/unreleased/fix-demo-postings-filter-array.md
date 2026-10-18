---
section: Changed
---

- The demo's `sample-accounting-rest` Connection declares `listPostings.filter` as an array
  of strings, sent as repeated `filter` keys, so one client's month is three values: client,
  first day and the day after the month. A paged Workflow step reads the large client's
  100,000 bookings of a month in one run.
