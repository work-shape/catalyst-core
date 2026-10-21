import { WORKFLOW_STEP_DATA_MAX_BYTES } from "../../limits";

/** How a step's input is mapped from literals and earlier steps. */
export const mappingsSection = `## Mappings and references

The \`input\` of a step is a mapping: one entry per field, and each entry is exactly one of

- \`value: <any JSON>\`: a literal, and
- \`ref: { step: <id of an earlier step>, path: <dotted path into its output> }\`: a field of
  what an earlier step answered, and
- \`text: [<part>, ...]\` for a field whose schema is a string: literal strings and
  \`{ ref: { step, path } }\` parts, joined in order, such as
  \`subject: { text: ["Prüfergebnis ", { ref: { step: start, path: input.month } }] }\`. A
  referenced part is a text, a number or a yes-or-no value; \`null\` joins as empty text. In a
  field whose schema has \`format: markdown\`, such as the body of a mail, a referenced list of
  strings joins as a bulleted list and a list of flat records as a table of at most 100 rows
  and 8 columns, every referenced value is escaped, and a dataset is refused. Such a field
  mapped as one \`ref\`, such as an agent's answer as a mail's body, keeps the value's
  Markdown, but each of its links shows its address after its label, and images are left out.

A mapping holds no expression, no template and no arithmetic; joining text only joins. What
needs computing is done by the operation a step calls or by a code step.

- A reference names a step that ran before the step it stands in. A step outside a loop cannot
  name a step inside it.
- The path is dotted, such as \`rows\` or \`customer.address.city\`. An empty path is the whole
  output.
- The run's input is read from the trigger: \`{ step: <trigger id>, path: input.<field> }\`.
- Inside a loop, the id of the loop is the current item: \`{ step: <loop id>, path: <field> }\`.
  After the loop the same id is its counts: \`total\`, \`done\`, \`failed\`.
- What an operation answers decides the path into its output. Where you do not know the shape,
  say so to the person instead of guessing a path: a wrong path fails the run, not the save.

An MCP Connection operation's output is the MCP result: \`{ content, structuredContent }\`.
Prefer \`structuredContent\` when present. Many tools instead put JSON text in
\`content[0].text\`, where the block is \`{ type: "text", text }\`. That text is a string,
not a record: a mapping cannot reach a field inside it. Use a code step to parse the JSON
before mapping its fields, and handle a tool that answers prose instead. Inspect the actual
answer first; an App action wraps this same MCP result in its \`result\` field.

The input and the output of one step may each be at most ${WORKFLOW_STEP_DATA_MAX_BYTES} bytes as JSON. Dataset references count toward this bound; their rows do not.`;
