import { WORKFLOW_RULES_REVISION_INPUT } from "../../child-rules-revision";

const REVISION = WORKFLOW_RULES_REVISION_INPUT;
const ECHO = 'json.dump(json.load(open("input.json")), open("output.json", "w"))';

/** The steps of a parent that keeps the rules revision in one value. A test parses them. */
const RULES_REVISION_STEPS = `- id: rules
  name: Rules revision
  type: code
  file: rules.py
  input:
    ${REVISION}: { value: rules-4 }
  inputSchema:
    { type: object, properties: { ${REVISION}: { type: string } }, required: [${REVISION}] }
  outputSchema:
    { type: object, properties: { ${REVISION}: { type: string } }, required: [${REVISION}] }
- id: each_client
  name: For each client
  type: loop
  items: { step: start, path: input.clients }
  steps:
    - id: check
      name: Check the client
      type: workflow
      workflow: check-client
      input:
        client: { ref: { step: each_client, path: id } }
        ${REVISION}: { ref: { step: rules, path: ${REVISION} } }
      key:
        - { value: "2026-09" }
        - { ref: { step: rules, path: ${REVISION} } }
        - { ref: { step: each_client, path: id } }`;

/** How a Workflow keeps Mandant data apart and its rules revision in one value. */
export const dataScopeSection = `## Preparing data scope

Follow the build rules for data scope in the platform docs: \`references/configure/release-config.md\` in \`platform-docs\`.

- Write the Mandant key on every copied row and keep it in aggregates and run history.
- Design per-Mandant work as child runs keyed by the Mandant and the period, such as \`key: [{ value: "2026-09" }, { ref: { step: <loop id>, path: <the Mandant's number> } }]\`. Starting the parent again for that period then runs only the children that did not end done. Do not replace them with an unkeyed cross-Mandant run.
- Keep the rules revision of a check in one authored value. Give the child a required input
  \`${REVISION}: { type: string }\` and let its script read the revision from that input, never
  from a constant of its own. In the parent, write the value once, as the literal input of a
  \`code\` step whose script, \`steps/rules.py\`, returns its input (\`${ECHO}\`), and reference
  that step's output in the child's input and in its key alike:

  \`\`\`yaml
${RULES_REVISION_STEPS.replace(/^/gmu, "  ")}
  \`\`\`

  When a rule changes, change the child's script and that one literal. No reference reaches into
  another definition, so the parent cannot read the child's revision. A check warns with
  \`child_key_without_rules_revision\` where a keyed step passes \`${REVISION}\` to a child that
  declares it and the key holds neither that source nor the child's \`const\`. It reads the
  mappings, the keys and the child's inputs, never a script: a revision kept only in a script is
  not checked, and a key without the revision lets the children that are done answer with what
  they found under the old rules.
- Say who a Workflow is for when it serves only part of the firm. Everyone in that audience must be allowed to see every Mandant the shared source credential can read.`;
