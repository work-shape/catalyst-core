import { WORKFLOW_CODE_ERRORS } from "../../code-step";

/** Bulk rows as datasets: in operations, loops, code steps and loads. */
export const datasetsSection = `## Datasets

For bulk object rows, set \`dataset: { at: rows }\` on an operation step when its answer has a list at \`rows\`. The step replaces that list with \`{ $dataset, rowCount, bytes }\`. Later mappings reference the same path. Never invent a dataset id or put its rows into a step record.

Declare a dataset field as \`{ type: dataset, row: <JSON Schema of one object row> }\`. A manifest may declare reusable row schemas under \`types\` and use \`row: { $ref: "#/types/<name>" }\`. A producer must guarantee the fields and types the consumer requires; extra fields fit. Each row is checked as it is written. A schema error names the line and field, never the value.

A loop may read a dataset as \`items\`, under the loop's item limit. With \`onItemFailure: continue\`, it returns counts and a \`failures\` dataset of index, optional label and error code. A loop does not return its item results inline. Keep bulk processing in operations rather than making a step run per data row.

Workflow inputs and outputs, including child inputs and results, may contain dataset references. A run reads only datasets it wrote, received as input or got from a child. A person passing a dataset into a root run needs \`workflow.read_run_data\` on its source Workflow. Dataset rows never reach an \`agent\` step in this release (EW-14b).

A \`code\` step reads and writes datasets as files; its container still has no network. A dataset in its \`inputSchema\` reaches the script as \`{ "path": "/work/in/<field>.jsonl", "rowCount": <n> }\`: a read-only file of JSON Lines, one row per line. Read it line by line and never load it whole. To write a dataset, declare it in \`outputSchema\` as \`{ type: dataset, row: ... }\`, write one JSON object per line to a file directly in \`/work/out/\` and name that file in the result as \`{ "path": "/work/out/findings.jsonl" }\`. Write findings that way, not as a list in the result, which stays small:

\`\`\`python
import json
data = json.load(open("input.json"))
with open(data["postings"]["path"]) as rows, open("/work/out/findings.jsonl", "w") as out:
    for line in rows:
        posting = json.loads(line)
        if posting["amount"] < 0:
            out.write(json.dumps({"client_id": posting["client_id"], "rule": "negative"}) + "\\n")
json.dump({"findings": {"path": "/work/out/findings.jsonl"}}, open("output.json", "w"))
\`\`\`

After the script ended, every line of a named file is checked against the row schema while it is stored. A line that is no JSON object of that schema fails the step with \`dataset_row_invalid\` and its line number, never its content. A path that is not one file directly in \`/work/out/\` fails with \`${WORKFLOW_CODE_ERRORS.datasetPathInvalid}\`; a link, a pipe, a folder or a missing file with \`${WORKFLOW_CODE_ERRORS.datasetFileInvalid}\`. The input files and what a script writes to \`/work/out/\` are bounded together by the release setting \`workflows.codeSteps.diskBytes\`, 2 GiB unless set; past it the step fails with \`${WORKFLOW_CODE_ERRORS.diskLimit}\`. A dataset the input names twice is one file.

Successful runs release intermediates. Failed runs retain datasets for their resume window; root output datasets default to seven days, or \`retention: { datasets: <days> }\`, bounded by step-data retention. Test roots keep no output datasets. Operator ceilings live under \`workflows.datasets\`; they are settings, not fixed customer limits. A producing step that reaches one fails with \`dataset_limit\` and its name. Deleted or unavailable parts answer \`dataset_expired\`.

A reading Connection operation may declare paging by page, offset, cursor or next_link. Use \`paginate: true\` with \`dataset: { at: items }\` to take its paging settings, or override fields with \`paginate: { size: 100 }\`. Other output fields come from the first page. One paged step keeps one Operation Run with counts only. A lost worker resumes at the last complete page. Rows, bytes, pageBytes and pages are operator ceilings under \`workflows.datasets\`. The minute ceiling is \`workflows.limits.pagedStepMinutes\`; the Workflow may set \`limits.pagedStepMinutes\` under it. A limit fails the step, so no consumer gets a partial dataset. A changing source can repeat or skip rows between pages; load with a key removes repeats.

A Data Store query with \`dataset: { at: rows }\` reads its full cursor into a dataset instead of the ordinary inline row cap. To put those rows into a table, call \`data_store.<id>.load\` with \`{ table, dataset }\`. Optional \`columns\` maps row fields to columns; \`key\` names a unique constraint, \`onConflict: skip | update\` needs that key, and \`replace: { by: [columns] }\` replaces the matching groups (each column of \`by\` is part of \`key\`). When a rerun may find no rows, name the group the step owns with \`replace: { by: [client_id, month, rules_revision], values: { client_id, month, rules_revision } }\`: \`values\` gives exactly the columns of \`by\` as non-null scalars, taken from the scope the step was asked for, not from its rows. An empty dataset then clears that group only, and a row outside it refuses the whole load. A mapping holds no template, so build the \`replace\` object in a \`code\` step from that scope and pass it with one reference. A retry of the same step returns the first load result. Loads need \`data_store.insert\`, plus \`data_store.execute\` for update or replace. The operator controls \`dataStores.load\` and \`dataStores.queryTimeoutMs\`; if a dataset exceeds one atomic load, produce smaller datasets upstream or ask the operator to raise its ceiling.

A dataset returned by the run can be downloaded as JSON Lines or CSV through \`workflows.download_dataset\`. Rows need \`workflow.read_run_data\`, or the caller must have started that run. Collection is still deferred; do not offer it.`;
