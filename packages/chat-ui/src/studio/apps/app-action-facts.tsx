import type { AppAction } from "@work-shape/catalyst-api-client";
import { Badge } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { appActionOutcome } from "./app-actions-model";

// The facts of one named action as every place words them: the Actions side of a draft, the
// Details of an App and the test dialog.

export function AppActionEffect({ effect }: { effect: AppAction["effect"] }) {
  const { t } = useTranslation();
  return (
    <Badge size="sm" tone={effect === "changing" ? "warning" : "neutral"}>
      {t(effect === "changing" ? "connections.effectChanging" : "connections.effectReading")}
    </Badge>
  );
}

/**
 * What an action reaches: the Connection by the name people read and its operation, the
 * Data Store a statement reads or adds a row to, or the Workflow it starts.
 */
export function AppActionTarget({ action }: { action: AppAction }) {
  const { name, title, verb } =
    action.kind === "sql"
      ? { ...action.dataStore, verb: action.kind }
      : action.kind === "workflow"
        ? { ...action.workflow, title: undefined, verb: "start" }
        : { ...action.connection, verb: action.operation };
  return (
    <span className="wrap-anywhere">
      {title ?? name}
      <span aria-hidden="true" className="text-muted-foreground">
        {" · "}
      </span>
      <code className="font-mono text-code">{verb}</code>
    </span>
  );
}

/** What a call of the action would come to for the reader. */
export function AppActionOutcomeBadge({
  action,
  safeMode = false
}: {
  action: Pick<AppAction, "effect" | "policy">;
  /** The place shows the draft as its frame runs it, where nothing changing is carried out. */
  safeMode?: boolean;
}) {
  const { t } = useTranslation();
  const outcome = appActionOutcome(action, safeMode);
  return (
    <Badge size="sm" tone={outcome.tone} dot data-policy={action.policy}>
      {t(outcome.labelKey)}
    </Badge>
  );
}
