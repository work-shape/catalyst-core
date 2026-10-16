import { z } from "zod";
import { publishedDefinitions, type WorkflowFixture } from "./workflow-instance";
import { readyWorkflows } from "./workflow-runs";

export async function readyChildWorkflows(
  opened: (fixture: WorkflowFixture) => void,
  definitions = publishedDefinitions(),
  options: { now?: () => Date; duration?: number } = {}
) {
  const t = await readyWorkflows(opened, {
    definitions: definitions.source,
    ...(options.now ? { now: options.now } : {}),
    ...(options.duration ? { limits: { maxDurationMs: options.duration } } : {})
  });
  await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
  t.state.limits = { ...t.state.limits, resultMaxBytes: 64 * 1_024 };
  t.state.centralSettings = [
    ...t.state.centralSettings,
    { operation: "workflow.parent.start", value: "allow" }
  ];
  t.setBehaviour((_operation, input) =>
    Promise.resolve({ value: z.object({ text: z.string() }).parse(input).text })
  );
  return t;
}
