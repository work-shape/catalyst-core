import { Fragment, type ReactNode } from "react";
import { TextLink } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { WorkflowAppCallerView } from "./workflow-views";
import { routeLink, type OpenRoute } from "./workflows-frame";

/** How many Apps a card names before it counts the rest. */
const NAMED_ON_CARD = 2;

/** Stands in a translated sentence where its list goes. */
const LIST_SLOT = "\u0001";

/**
 * The one line that says which Apps start a Workflow, each App a link to its page: "Started by
 * the app “A”". On a card, past two Apps the rest are counted; on the Workflow's page every App
 * is named. The Apps are joined as the reader's language joins a list. No line where no App the
 * reader may open starts the Workflow.
 */
export function WorkflowAppCallers({
  callers,
  workspaceId,
  onOpenRoute,
  all = false
}: {
  callers: readonly WorkflowAppCallerView[] | undefined;
  /** The workspace open now: an App of the instance's own opens there. */
  workspaceId: string;
  onOpenRoute: OpenRoute;
  /** Every App is named, as the Workflow's page names them. */
  all?: boolean;
}) {
  const { locale, t } = useTranslation();
  if (callers === undefined || callers.length === 0) return null;
  const named = all || callers.length <= NAMED_ON_CARD ? callers : callers.slice(0, NAMED_ON_CARD);
  const rest = callers.length - named.length;
  const [quoteBefore = "", quoteAfter = ""] = t("workflows.appCallers.quoted", {
    title: LIST_SLOT
  }).split(LIST_SLOT);
  const items: ReactNode[] = named.map((caller) => (
    <span key={`${caller.workspaceId ?? ""}/${caller.id}`}>
      {quoteBefore}
      <TextLink
        className="wrap-anywhere"
        {...routeLink(
          {
            kind: "app",
            // The instance's own opens in the workspace open now, as every link to it does.
            collaborationWorkspaceId: caller.workspaceId ?? workspaceId,
            app: caller.id
          },
          onOpenRoute
        )}
      >
        {caller.title}
      </TextLink>
      {quoteAfter}
    </span>
  ));
  if (rest > 0) {
    items.push(
      <span key="more">
        {t("workflows.appCallers.more", { count: new Intl.NumberFormat(locale).format(rest) })}
      </span>
    );
  }
  const [before = "", after = ""] = t(
    callers.length === 1 ? "workflows.appCallers.one" : "workflows.appCallers.many",
    { apps: LIST_SLOT }
  ).split(LIST_SLOT);
  return (
    <p className="text-caption text-muted-foreground" data-workflow-app-callers="">
      {before}
      {joined(items, locale)}
      {after}
    </p>
  );
}

/** The items joined as the reader's language joins a list: "A, B and C", "A, B und C". */
function joined(items: readonly ReactNode[], locale: string): ReactNode {
  const parts = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).formatToParts(
    items.map((_, index) => String(index))
  );
  return parts.map((part, index) =>
    part.type === "element" ? (
      <Fragment key={`item-${part.value}`}>{items[Number(part.value)]}</Fragment>
    ) : (
      <Fragment key={`literal-${index}`}>{part.value}</Fragment>
    )
  );
}
