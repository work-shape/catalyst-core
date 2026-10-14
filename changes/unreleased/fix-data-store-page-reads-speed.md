---
section: Fixed
---

- **The test of every kind of table and every page size of a Data Store's page no longer runs
  into its timeout:** it read 666 pages one after the other, about 13 seconds on an idle
  machine and over 30 on a busy CI runner. It now reads about 350 pages, the six tables side by
  side, in about 3 seconds. Every table is still read whole at every page size, and a page of
  every size still starts in one part of a table and goes on in the next. A cursor that answers
  a row again now fails the test at once instead of at the timeout.
