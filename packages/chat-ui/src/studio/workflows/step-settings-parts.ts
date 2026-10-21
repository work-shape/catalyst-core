import type { ReactNode } from "react";
import type { useTranslation } from "../../shared/i18n";
import type { WorkflowEditing } from "./workflow-editing";

// What the forms of the kinds of step in a step's Settings tab share (workflow-canvas 9.4).

type Step = Readonly<Record<string, unknown>>;
export type Translate = ReturnType<typeof useTranslation>["t"];

/** What the form of one kind of step is given. */
export interface KindProps {
  step: Step;
  stepId: string;
  editing: WorkflowEditing;
  /** What the instance says of a field of the step. */
  issue(field: string): string | undefined;
  /** Under a field: the agent's value where it changed it meanwhile, and the published one. */
  under(field: string): ReactNode;
  set(fields: Record<string, unknown>): void;
}

/** How the fields of earlier results are headed in a picker. */
export function fieldWords(t: Translate) {
  return {
    entry: (loop: string) => t("workflows.settings.entryOf", { loop }),
    input: t("workflows.settings.runInput")
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
