import { Bot, ChevronRight, ShieldCheck, User as UserIcon } from "lucide-react";
import { useState } from "react";
import type {
  AuditActivity,
  AuditActivityActor,
  AuditActivityTarget,
  AuditEvent
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chip,
  cn,
  EmptyState,
  PageHeader,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@vivd-catalyst/ui";
import { useTranslation, type TranslationContextValue, type TranslationKey } from "../i18n";
import { formatDateTime } from "./locale-format";

export function AuditView({
  auditActivities,
  error
}: {
  /** Absent while the activities load. */
  auditActivities: AuditActivity[] | undefined;
  /** Why the activities could not be loaded. */
  error?: string;
}) {
  const { t, locale } = useTranslation();
  const header = (
    <PageHeader
      title={t("settings.audit")}
      description={
        auditActivities
          ? t(
              auditActivities.length === 1 ? "settings.auditCountOne" : "settings.auditCountOther",
              { count: auditActivities.length.toLocaleString(locale) }
            )
          : undefined
      }
    />
  );
  if (error) {
    return (
      <>
        {header}
        <Banner tone="danger">{error}</Banner>
      </>
    );
  }
  if (!auditActivities) {
    return (
      <>
        {header}
        <SkeletonList />
      </>
    );
  }
  if (auditActivities.length === 0) {
    return (
      <>
        {header}
        <EmptyState>{t("settings.auditEmpty")}</EmptyState>
      </>
    );
  }
  return (
    <>
      {header}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">{t("settings.auditRecentActivity")}</CardTitle>
          <p className="text-xs text-muted-foreground">{t("settings.auditDescription")}</p>
        </CardHeader>
        <CardContent className="p-4 pt-1">
          <ul className="divide-y">
            {auditActivities.map((activity) => (
              <AuditActivityRow key={activity.correlationId} activity={activity} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}

function AuditActivityRow({ activity }: { activity: AuditActivity }) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const showReason = Boolean(activity.reason) && activity.outcome !== "success";

  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 rounded-md px-1 py-1 text-left hover:bg-muted/40"
      >
        <ChevronRight
          size={16}
          aria-hidden="true"
          className={cn(
            "mt-0.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{activity.label}</span>
            <OutcomeBadge outcome={activity.outcome} />
            {activity.repeatCount > 1 ? (
              <span className="text-xs text-muted-foreground">×{activity.repeatCount}</span>
            ) : null}
            {activity.tier === "governance" ? (
              <Badge className="gap-1">
                <ShieldCheck size={12} aria-hidden="true" />
                {t("settings.auditTierGovernance")}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">{formatDateTime(activity.at, locale)}</span>
            <ActorChip actor={activity.actor} />
            {activity.target ? (
              <span className="break-all">{targetText(activity.target)}</span>
            ) : null}
            <span className="whitespace-nowrap">
              {t(
                activity.eventCount === 1
                  ? "settings.auditEventCountOne"
                  : "settings.auditEventCountOther",
                { count: activity.eventCount }
              )}
            </span>
          </div>
          {showReason ? (
            <p className="text-xs break-words text-destructive">{activity.reason}</p>
          ) : null}
        </div>
      </button>
      {open ? <AuditEvidence evidence={activity.evidence} /> : null}
    </li>
  );
}

function AuditEvidence({ evidence }: { evidence: AuditEvent[] }) {
  const { t, locale } = useTranslation();
  return (
    <div className="mt-2 ml-6 overflow-hidden rounded-md border bg-muted/30">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("settings.time")}</TableHead>
            <TableHead>{t("settings.auditEvent")}</TableHead>
            <TableHead>{t("settings.status")}</TableHead>
            <TableHead>{t("settings.auditActor")}</TableHead>
            <TableHead>{t("settings.auditSubject")}</TableHead>
            <TableHead>{t("settings.auditReason")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {evidence.map((event) => (
            <TableRow key={event.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDateTime(event.createdAt, locale)}
              </TableCell>
              <TableCell className="font-mono text-xs break-words">{event.type}</TableCell>
              <TableCell>
                <Badge
                  tone={event.status === "success" ? "success" : "neutral"}
                  appearance={event.status === "success" ? "soft" : "outline"}
                  className={cn(
                    "capitalize",
                    event.status !== "success" && "border-destructive/40 text-destructive"
                  )}
                >
                  {eventStatusText(event.status, t)}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{evidenceActorText(event, t)}</TableCell>
              <TableCell className="break-all text-muted-foreground">
                {event.subject ?? "—"}
              </TableCell>
              <TableCell className="break-words text-muted-foreground">
                {evidenceReasonText(event) ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {evidence[0] ? (
        <p className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {t("settings.auditCorrelation", { id: evidence[0].correlationId })}
        </p>
      ) : null}
    </div>
  );
}

const OUTCOME_LABEL_KEYS: Record<AuditActivity["outcome"], TranslationKey> = {
  success: "settings.auditOutcomeSuccess",
  warning: "settings.auditOutcomeWarning",
  failed: "settings.auditOutcomeFailed",
  denied: "settings.auditOutcomeDenied"
};

// The contract carries the event status as an open string, so an unknown value is shown as sent.
const EVENT_STATUS_LABEL_KEYS: Partial<Record<string, TranslationKey>> = {
  success: "settings.auditOutcomeSuccess",
  failed: "settings.auditOutcomeFailed",
  denied: "settings.auditOutcomeDenied"
};

function eventStatusText(status: string, t: Translate): string {
  const key = EVENT_STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

function OutcomeBadge({ outcome }: { outcome: AuditActivity["outcome"] }) {
  const { t } = useTranslation();
  const label = t(OUTCOME_LABEL_KEYS[outcome]);
  if (outcome === "success") {
    return <Badge tone="success">{label}</Badge>;
  }
  if (outcome === "warning") {
    return (
      <Badge appearance="outline" className="border-amber-500 text-amber-600">
        {label}
      </Badge>
    );
  }
  return (
    <Badge appearance="outline" className="border-destructive/50 text-destructive">
      {label}
    </Badge>
  );
}

function ActorChip({ actor }: { actor: AuditActivityActor }) {
  const { t } = useTranslation();
  const Icon = actor.kind === "assistant" ? Bot : actor.kind === "user" ? UserIcon : ShieldCheck;
  return (
    <Chip size="sm" leading={<Icon aria-hidden="true" className="size-3" />}>
      {actorText(actor, t)}
    </Chip>
  );
}

type Translate = TranslationContextValue["t"];

function actorText(actor: AuditActivityActor, t: Translate): string {
  if (actor.kind === "assistant") {
    return actor.onBehalfOf
      ? t("settings.auditActorAssistantFor", { name: actor.onBehalfOf })
      : t("settings.auditActorAssistant");
  }
  if (actor.kind === "service") {
    return t("settings.auditActorService", { name: actor.label });
  }
  return actor.label;
}

function targetText(target: AuditActivityTarget): string {
  return `${target.kind}: ${target.label ?? target.id}`;
}

function evidenceActorText(event: AuditEvent, t: Translate): string {
  const actor = event.actor;
  if (!actor) {
    return t("settings.auditActorSystem");
  }
  if (actor.delegatedActor) {
    return t("settings.auditActorDelegated", {
      delegate: actor.delegatedActor.displayLabel ?? t("settings.auditActorAssistant"),
      name: actor.displayLabel
    });
  }
  return actor.displayLabel;
}

function evidenceReasonText(event: AuditEvent): string | undefined {
  if (event.reason) {
    return event.reason;
  }
  const metadata = event.metadata as Record<string, unknown> | undefined;
  for (const key of ["reason", "code"]) {
    const value = metadata?.[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}
