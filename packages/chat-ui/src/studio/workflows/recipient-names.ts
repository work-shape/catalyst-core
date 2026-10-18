import type { TranslationContextValue } from "../../shared/i18n";
import type { WorkflowStepView } from "./workflow-views";

// Who a Notify step reaches, in names (workflow-canvas.md, Notify: "Who receives it"). The
// definition names people and workspaces by id. The names come only from what the reader may
// read already: who they are, their own workspaces, and the instance's people for a reader who
// manages them. Whoever stays unnamed is counted, never shown by id.

/** The names the reader may read, by id. */
export interface RecipientNames {
  people: ReadonlyMap<string, string>;
  workspaces: ReadonlyMap<string, string>;
}

export const NO_RECIPIENT_NAMES: RecipientNames = { people: new Map(), workspaces: new Map() };

type Text = Pick<TranslationContextValue, "locale" | "t">;

/**
 * "Mara Lindqvist and Team Finanzen", "Mara Lindqvist and 2 other people", "3 people". Nothing
 * for a step that names nobody.
 */
export function recipientsLine(
  to: WorkflowStepView["to"],
  names: RecipientNames,
  { t, locale }: Text
): string | undefined {
  if (to === undefined) return undefined;
  const count = (value: number) => value.toLocaleString(locale);
  const named: string[] = [];
  let people = 0;
  let workspaces = 0;
  for (const id of to.users) {
    const name = names.people.get(id);
    if (name === undefined) people += 1;
    else named.push(name);
  }
  for (const id of to.workspaces) {
    const name = names.workspaces.get(id);
    if (name === undefined) workspaces += 1;
    else named.push(name);
  }
  const others = named.length > 0;
  const parts = [
    ...named,
    ...(people === 0
      ? []
      : [
          others
            ? t(
                people === 1
                  ? "workflows.recipients.otherPeopleOne"
                  : "workflows.recipients.otherPeople",
                {
                  count: count(people)
                }
              )
            : t(people === 1 ? "workflows.recipients.peopleOne" : "workflows.recipients.people", {
                count: count(people)
              })
        ]),
    ...(workspaces === 0
      ? []
      : [
          others
            ? t(
                workspaces === 1
                  ? "workflows.recipients.otherWorkspacesOne"
                  : "workflows.recipients.otherWorkspaces",
                { count: count(workspaces) }
              )
            : t(
                workspaces === 1
                  ? "workflows.recipients.workspacesOne"
                  : "workflows.recipients.workspaces",
                { count: count(workspaces) }
              )
        ])
  ];
  return parts.length === 0
    ? undefined
    : new Intl.ListFormat(locale, { type: "conjunction" }).format(parts);
}
