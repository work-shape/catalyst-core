import { toWorkflow } from "@work-shape/catalyst-chat-ui/workflows";

const steps = [
  { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
  { id: "clients", name: "Load the clients", type: "operation", operation: "connection.crm.list" },
  {
    id: "each_client",
    name: "For each client",
    type: "loop",
    items: { step: "clients", path: "" },
    itemName: "client",
    steps: [
      { id: "send", name: "Send the note", type: "operation", operation: "connection.crm.write" }
    ]
  },
  { id: "result", name: "Result", type: "output", input: {} }
];
export const definitionOf = (changed: Record<string, Record<string, unknown>> = {}) => ({
  id: "notify-clients",
  name: "Notify clients",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: steps.map((step) => ({ ...step, ...changed[step.id] })),
  wiring: []
});
export const workflowOf = (
  changed?: Record<string, Record<string, unknown>>,
  stepFacts: NonNullable<Parameters<typeof toWorkflow>[2]>["stepFacts"] = {
    clients: { source: { kind: "connection" } },
    send: { source: { kind: "connection" } }
  }
) =>
  toWorkflow(
    { name: "notify-clients", config: definitionOf(changed), publishedRevision: 1 },
    {},
    { stepFacts }
  );
