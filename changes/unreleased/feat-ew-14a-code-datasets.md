---
section: Added
---

- A Workflow `code` step reads and writes datasets (EW-14a). A dataset in its input reaches
  the script as a read-only file of JSON Lines, named in the input as
  `{ "path": "/work/in/<field>.jsonl", "rowCount": n }`. The script writes a dataset as a file
  directly in `/work/out/` and names it in its result as `{ "path": "/work/out/<name>.jsonl" }`;
  the command worker stores it, checking every line against the row schema, and a line that
  does not fit fails the step with its line number and no content. The container keeps no
  network. The worker opens only a regular file directly in `/work/out`, without following a
  link, and stops at the bound while it reads: a link, a pipe, a folder, a nested path or a
  name that leaves the directory fails the step (`code_dataset_file_invalid`,
  `code_dataset_path_invalid`). The input files and what a script writes to `/work/out` are
  bounded together by the new release setting `workflows.codeSteps.diskBytes`, 2 GiB unless
  set (`code_disk_limit`); a dataset the input names twice is written once. The
  code step reads only datasets its run may read, checked when the step is staged and again
  by the worker. A dataset into an `agent` step stays refused (EW-14b).
