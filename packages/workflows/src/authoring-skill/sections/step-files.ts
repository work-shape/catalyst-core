/** The source tree contract of a code step (WF-TREE). */
export const stepFilesSection = `## The step files of a code step

A Workflow folder holds workflow.yaml and its source tree: shared modules, SQL, tests and
other files. A code step names \`entry: lib/run.py\` (\`.py\`, \`.js\` or \`.mjs\`).
The deprecated \`file: run.py\` alias names \`steps/run.py\` for one more release.
It keeps its writable scratch cwd and relative input.json/output.json IO while importing from
the read-only tree, so published scripts continue to run unchanged.
Every entry must exist (\`code_file_missing\`); files no step names are accepted.
Paths are relative, with no traversal, .git component, symlink, submodule or executable mode.
The operator bounds file bytes, file count, tree bytes and history in \`workflows.source.*\`;
inspect the capability list for this instance's settings. A refusal names the setting.

The sandbox gets the whole tree of the run's immutable revision, read-only. Its cwd is the
root for entry steps, on PYTHONPATH and NODE_PATH, so Python can import from lib/. Node resolves relative modules normally and falls back to the root for bare module paths
in both CommonJS and ESM. Nothing reads git on a run.
A later publish or delete never changes that run's files. Source holds no run data or secrets.
The container has no network or platform credentials.

Input is JSON on stdin and at the absolute path in WORKFLOW_INPUT_FILE. Print the JSON result,
or write it to WORKFLOW_OUTPUT_FILE, a writable path outside the read-only tree. Do not write
output.json in the tree. Input and output are checked against inputSchema and outputSchema.
An exit code other than zero fails the step. Datasets use the declared input/output paths.

Folder writes carry the whole tree. Config writes preserve the draft's other tree files.
For one release, scripts under steps/ that fit the old bounds are also written to config.files
for rollback. Runs read that field only for a revision that has no file set yet.
`;
