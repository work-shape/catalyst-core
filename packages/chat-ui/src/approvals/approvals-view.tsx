import { CircleAlert } from "lucide-react";
import { useState } from "react";
import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { useTranslation, type TranslationKey } from "../i18n";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Spinner } from "../ui/spinner";
import { APPROVAL_AUTH_SCOPE, useApprovalRequestListQuery } from "./approval-request-api";
import { ListedApprovalRequestCard } from "./approval-request-card";
import { decidedApprovalRequests } from "./approval-request-model";

type ApprovalsTab = "pending" | "history";

/**
 * The review queue. It is a workspace view of its own rather than an
 * administration tab, because holding an approval permission does not make
 * someone an administrator.
 */
export function ApprovalsView({ pendingCount }: { pendingCount: number }) {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const [tab, setTab] = useState<ApprovalsTab>("pending");
  const api = { apiBaseUrl, authScope: APPROVAL_AUTH_SCOPE, client };
  const pendingQuery = useApprovalRequestListQuery({
    ...api,
    status: "pending",
    enabled: tab === "pending"
  });
  // One unfiltered list instead of a request per decided status; it also picks
  // up statuses added to the contract later without a change here.
  const historyQuery = useApprovalRequestListQuery({ ...api, enabled: tab === "history" });
  const query = tab === "pending" ? pendingQuery : historyQuery;
  const requests =
    tab === "pending"
      ? (pendingQuery.data ?? [])
      : decidedApprovalRequests(historyQuery.data ?? []);

  return (
    <section
      className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background"
      aria-label={t("approvals")}
    >
      <div className="grid gap-3 border-b px-5 pt-20">
        <h1 className="text-xl font-semibold tracking-normal">{t("approvals")}</h1>
        <nav className="flex items-end gap-1 overflow-x-auto" aria-label={t("approvals")}>
          <ApprovalsTabButton
            active={tab === "pending"}
            label={t("approvalsTabPending")}
            badge={pendingCount > 0 ? pendingCount : undefined}
            onClick={() => setTab("pending")}
          />
          <ApprovalsTabButton
            active={tab === "history"}
            label={t("approvalsTabHistory")}
            onClick={() => setTab("history")}
          />
        </nav>
      </div>

      <div className="chat-scrollbar min-h-0 overflow-auto p-5">
        <div className="mx-auto grid w-full max-w-3xl content-start gap-4">
          <ApprovalRequestList
            requests={requests}
            loading={query.isPending}
            failed={query.isError}
            emptyKey={tab === "pending" ? "approvalsEmptyPending" : "approvalsEmptyHistory"}
            onRetry={() => void query.refetch()}
          />
        </div>
      </div>
    </section>
  );
}

export function ApprovalRequestList({
  requests,
  loading,
  failed,
  emptyKey,
  onRetry
}: {
  requests: ApprovalRequestView[];
  loading: boolean;
  failed: boolean;
  emptyKey: TranslationKey;
  onRetry(): void;
}) {
  const { t } = useTranslation();

  if (requests.length > 0) {
    return (
      <>
        {requests.map((request) => (
          <ListedApprovalRequestCard key={request.id} request={request} />
        ))}
      </>
    );
  }
  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="alert">
        <CircleAlert size={15} className="shrink-0 text-destructive" aria-hidden="true" />
        <span>{t("approvalsLoadFailed")}</span>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          {t("tryAgain")}
        </Button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner size="sm" />
        <span>{t("approvalsLoading")}</span>
      </div>
    );
  }
  return (
    <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
      {t(emptyKey)}
    </p>
  );
}

function ApprovalsTabButton({
  active,
  label,
  badge,
  onClick
}: {
  active: boolean;
  label: string;
  badge?: number;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 rounded-t-md border-b-2 border-transparent px-3 pt-2 pb-2.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active && "border-primary text-foreground"
      )}
      onClick={onClick}
    >
      {label}
      {badge !== undefined ? (
        <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
