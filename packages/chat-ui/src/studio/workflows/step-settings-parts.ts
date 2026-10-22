import type { ReactNode } from "react";
import type { useTranslation } from "../../shared/i18n";
import type { FieldListItem } from "@work-shape/catalyst-ui";
import { fieldListProblems } from "./schema-fields";
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
  /**
   * The sentence for a field with no value, where the form says it yet: after the field was
   * left or a Save was tried (`WorkflowEditing.saysMissing`).
   */
  missing(field: string, empty: boolean, sentence: string): string | undefined;
  /** For a field's `onBlur`: the field was left, and the instance is asked what it refuses. */
  left(field: string): () => void;
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

/**
 * What a list of fields says and holds (WF-EDIT-4): a key twice holds the save and is said at
 * once; a missing title or choice is said once the field was left or a Save was tried, and
 * lets the first Save say it.
 */
export function fieldListState(
  items: readonly FieldListItem[],
  says: (id: string) => boolean,
  t: Translate
) {
  const problems = fieldListProblems(items);
  const entries = Object.entries(problems);
  const errors = Object.fromEntries(
    entries.map(([id, problem]) => [
      id,
      {
        ...(problem.title === undefined || !says(id)
          ? {}
          : { title: t("workflows.settings.answerTitleMissing") }),
        ...(problem.name === undefined ? {} : { name: t("workflows.settings.answerNameTaken") }),
        ...(problem.choices === undefined || !says(id)
          ? {}
          : { choices: t("workflows.settings.answerChoicesMissing") })
      }
    ])
  );
  return {
    errors,
    held: entries.some(([, problem]) => problem.name !== undefined),
    lacking: entries.some(
      ([, problem]) => problem.title !== undefined || problem.choices !== undefined
    )
  };
}

/** The field of a list whose control lost the focus, for `WorkflowEditing.leave`. */
export function leftField(target: EventTarget): string | undefined {
  return target instanceof Element
    ? (target.closest("[data-field-id]")?.getAttribute("data-field-id") ?? undefined)
    : undefined;
}
