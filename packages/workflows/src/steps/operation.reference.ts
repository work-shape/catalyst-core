import type { StepReference } from "./module";

/** What the authoring skill says of a `operation` step. */
export const operationReference = {
  does: "Calls one operation by its name, as the account the Workflow runs as. Its output is what the operation answered. `mail.send` sends one e-mail as the instance's system sender and exists only where the instance sends mail: ask `platform.assets.operations` for it by exact `name` before you use it. Its `to`, `cc` and `bcc` take addresses, { user: id } and { workspace: id }; `subject` is one line; `body` is Markdown, where HTML and images are shown as text or dropped. It mails people of the instance and addresses in the domains the instance allows; a literal address outside them is refused at save. Its output holds the counts and the message id, never an address.",
  fields: {
    operation:
      "The full name of the operation, such as `connection.<connection>.<operation>`. Ask `platform.assets.operations` for the names and input schemas; filter by exact `name` or a `prefix` such as `connection.crm.` or `data_store.orders.`. Each page has at most 200 operations: pass `nextCursor` as `cursor` with the same filters until it is absent before concluding an operation does not exist. Do not guess a name. To run another Workflow and wait for its result, use a `workflow` step, not `workflow.<name>.start` here.",
    input:
      "The mapping onto the operation's input: one entry per field of its input schema. See 'Mappings and references'.",
    dataset:
      "Use { at: <dotted path> } to replace an object-row list in the answer with a dataset reference at the same path. Rows are streamed into the files store; the step record holds only the reference. See Datasets.",
    paginate:
      "Use true to take the reading Connection operation's paging, or an object to override its fields. Requires dataset.at. See Datasets.",
    timeout:
      "Only for an operation whose work ends after the call, such as the sync of a Knowledge Base: how long the step waits for it, such as `30m`, `6h` or `3d`; 6h when left out. The wait counts toward no limit of the run. At it the step fails with `operation_still_running` and the work goes on."
  }
} satisfies StepReference<"operation">;
