import type { PlatformEventDefinition } from "./definition";

const OPERATION_AUDIT = {
  subject: "operation",
  legacy: false,
  audited: true,
  phases: ["after"]
} as const;

export const operationEvents = {
  "operation.authorization_checked": {
    ...OPERATION_AUDIT,
    name: "operation.authorization_checked"
  },
  // Guardrails answer here before anything runs.
  "operation.before_call": {
    name: "operation.before_call",
    subject: "operation",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "operation.completed": { ...OPERATION_AUDIT, name: "operation.completed" },
  "operation.denied": { ...OPERATION_AUDIT, name: "operation.denied" },
  "operation.failed": { ...OPERATION_AUDIT, name: "operation.failed" },
  // A changing call of a draft that was not made and answered what it would have done.
  "operation.simulated": { ...OPERATION_AUDIT, name: "operation.simulated" },
  "operation.started": { ...OPERATION_AUDIT, name: "operation.started" }
} as const satisfies Record<string, PlatformEventDefinition>;
