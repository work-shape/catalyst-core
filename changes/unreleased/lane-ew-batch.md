---
section: Added
---

- Workflow loops accept `batch: N` over a dataset. Each iteration receives a view of at most N
  rows under the parent dataset's permissions and lifetime, without copying its objects; the
  loop item limit counts iterations. Code steps and Data Store loads honor these views.
  An inline list with `batch` fails with `batch_requires_dataset` ("batch on a loop needs a
  dataset"). Batch operations return `done`, `failed` and a failures dataset; partial item
  failures leave the step done. Malformed aggregates fail with `batch_result_invalid`.
  Failure messages must name only a field and code, never item content. No migration is needed.
  Rollback: remove `batch` from definitions, drain runs carrying dataset views and expire
  their retained dataset results before returning to an older engine, which does not
  understand the optional reference `offset`.

- Code steps resolve their current dataset loop item or batch before staging the worker input.
  Start refuses in-schema dataset views outside the stored row range. Data Store loads check
  the byte size of part-aligned views before reading and retain their streaming byte bound.
