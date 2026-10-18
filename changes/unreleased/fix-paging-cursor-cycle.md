---
section: Fixed
---

- A paged `cursor` or `next_link` step fails with `paging_repeated_cursor` as soon as the
  source returns a continuation the step has already read, such as A, B, A. Before, only a
  continuation repeated twice in a row was caught, and a cycle ran on to the page limit and
  failed with `dataset_limit`. The step rebuilds the continuations it has read from its
  dataset's page checkpoints, so the check holds across a deferral or a worker restart.
