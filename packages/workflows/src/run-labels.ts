import {
  AppError,
  workflowRunLabelsSchema,
  type JsonObject,
  type JsonValue,
  type WorkflowManifest,
  type WorkflowRunLabels
} from "@work-shape/catalyst-core";

/** Labels are evaluated once, from the trigger, and successors retain their original values. */
export function workflowLabels(
  manifest: WorkflowManifest,
  input: JsonObject
): WorkflowRunLabels | undefined {
  if (!manifest.labels) return undefined;
  const values: Record<string, string> = {};
  const trigger = manifest.steps[0];
  for (const [name, source] of Object.entries(manifest.labels)) {
    let value: JsonValue = source.value ?? null;
    if (source.ref) {
      if (source.ref.step !== trigger?.id)
        throw new AppError("VALIDATION_FAILED", "A label must refer to the trigger", {
          reason: "labels_invalid"
        });
      value = { input };
      for (const part of source.ref.path.split(".")) {
        value =
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.hasOwn(value, part)
            ? (value[part] ?? null)
            : null;
      }
    }
    if (typeof value !== "string" && typeof value !== "number")
      throw new AppError("VALIDATION_FAILED", "A label must be text or a number", {
        reason: "labels_invalid"
      });
    Object.defineProperty(values, name, {
      value: String(value),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  const parsed = workflowRunLabelsSchema.safeParse(values);
  if (!parsed.success)
    throw new AppError("VALIDATION_FAILED", "The labels do not fit the run label limits", {
      reason: "labels_invalid"
    });
  return parsed.data;
}
