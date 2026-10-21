/** A definition the examples of the skill show. `tests/fixtures/workflows` holds each as a file. */
const EXAMPLES: { title: string; yaml: string }[] = [
  {
    title: "Read from a Connection and return a part of the answer",
    yaml: `id: top-customers
name: Top customers
description: Reads the customers with the highest revenue from the sample system.
inputs:
  type: object
  properties:
    limit:
      type: integer
  required: [limit]
  additionalProperties: false
outputs:
  type: object
  properties:
    customers:
      type: array
  required: [customers]
steps:
  - id: start
    name: Start by hand
    type: trigger
    triggers:
      - kind: manual
  - id: top
    name: Read the top customers
    type: operation
    operation: connection.sample.top_customers
    input:
      limit:
        ref: { step: start, path: input.limit }
  - id: result
    name: Result
    type: output
    input:
      customers:
        ref: { step: top, path: structuredContent.rows }`
  },
  {
    title: "A loop that makes one changing call per item and returns its counts",
    yaml: `id: notify-clients
name: Notify clients
inputs:
  type: object
  properties:
    note:
      type: string
  required: [note]
outputs:
  type: object
steps:
  - id: start
    name: Start by hand
    type: trigger
    triggers:
      - kind: manual
  - id: clients
    name: Read the clients
    type: operation
    operation: connection.crm.echo
    input:
      text:
        ref: { step: start, path: input.note }
  - id: each_client
    name: For each client
    type: loop
    items: { step: clients, path: clients }
    itemLabel: id
    onItemFailure: continue
    steps:
      - id: send
        name: Send the note
        type: operation
        operation: connection.crm.write
        input:
          client:
            ref: { step: each_client, path: id }
          note:
            ref: { step: start, path: input.note }
  - id: result
    name: Result
    type: output
    input:
      sent:
        ref: { step: each_client, path: done }
      failed:
        ref: { step: each_client, path: failed }`
  },
  {
    title: "An agent step whose structured answer an App shows",
    yaml: `id: weekly-briefing
name: Weekly briefing
inputs:
  type: object
  properties:
    notes:
      type: string
  required: [notes]
outputs:
  type: object
  properties:
    priorities:
      type: array
    decisions:
      type: array
    sources:
      type: array
steps:
  - id: start
    name: Start by hand
    type: trigger
    triggers:
      - kind: manual
  - id: brief
    name: Write the briefing
    type: agent
    instructions: Read the notes and return the week's priorities, the decisions taken and the sources you used.
    input:
      notes:
        ref: { step: start, path: input.notes }
    inputSchema:
      type: object
      properties:
        notes:
          type: string
    outputSchema:
      type: object
      properties:
        priorities:
          type: array
          description: At most five, the most urgent first.
          items:
            type: object
            properties:
              title:
                type: string
              level:
                type: string
                enum: [high, medium, low]
            required: [title, level]
            additionalProperties: false
        decisions:
          type: array
          items:
            type: string
        sources:
          type: array
          items:
            type: object
            properties:
              title:
                type: string
              url:
                type: string
                description: The full address of the source.
            required: [title]
            additionalProperties: false
      required: [priorities, decisions, sources]
      additionalProperties: false
  - id: result
    name: Result
    type: output
    input:
      priorities:
        ref: { step: brief, path: priorities }
      decisions:
        ref: { step: brief, path: decisions }
      sources:
        ref: { step: brief, path: sources }`
  },
  {
    title: "A schedule and a literal value in a mapping",
    yaml: `id: nightly-check
name: Nightly check
inputs:
  type: object
outputs:
  type: object
  properties:
    month:
      type: string
steps:
  - id: start
    name: Every night at two, or by hand
    type: trigger
    triggers:
      - kind: schedule
        cron: "0 2 * * *"
      - kind: manual
  - id: read
    name: Read the open items
    type: operation
    operation: connection.crm.echo
    input:
      text:
        value: open-items
  - id: result
    name: Result
    type: output
    input:
      month:
        ref: { step: start, path: startedAt }`
  }
];

/** The examples of the skill, as the files they are written as. A test parses each. */
export const WORKFLOW_AUTHORING_EXAMPLES: readonly { title: string; yaml: string }[] = EXAMPLES;

export const examplesSection = `## Examples\n\n${EXAMPLES.map(
  ({ title, yaml }) => `### ${title}\n\n\`\`\`yaml\n${yaml}\n\`\`\``
).join("\n\n")}`;
