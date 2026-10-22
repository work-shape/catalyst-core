import { Bot, ChevronRight, ShieldCheck, User as UserIcon } from "lucide-react";
import { useState } from "react";
import type {
  AuditActivity,
  AuditActivityActor,
  AuditEvent
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chip,
  cn,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  EmptyState,
  PageHeader,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import { formatDateTime } from "../../shared/locale-format";
import {
  auditEventAction,
  auditEventReason,
  auditEventText,
  auditReasonText,
  auditSubjectText,
  auditTargetText
} from "./audit-words";

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
  const reason = activity.outcome === "success" ? undefined : activity.reason;
  const target = activity.target ? auditTargetText(activity.target, t) : undefined;

  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <button
        type="button"
        data-audit-activity=""
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
            <span className="font-medium">{auditEventText(activity.type, activity.action, t)}</span>
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
            {target ? <span className="break-words">{target}</span> : null}
            <span className="whitespace-nowrap">
              {t(
                activity.eventCount === 1
                  ? "settings.auditEventCountOne"
                  : "settings.auditEventCountOther",
                { count: activity.eventCount }
              )}
            </span>
          </div>
          {reason ? (
            <p className="text-xs break-words text-destructive">{auditReasonText(reason, t)}</p>
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
              <TableCell className="break-words">
                {auditEventText(event.type, auditEventAction(event), t)}
              </TableCell>
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
              <TableCell className="break-words text-muted-foreground">
                {auditSubjectText(event.about, t) ?? "—"}
              </TableCell>
              <TableCell className="break-words text-muted-foreground">
                {evidenceReasonText(event, t) ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {evidence[0] ? (
        // The correlation id is for whoever traces the request, folded away like every id.
        <Disclosure className="px-3 py-1">
          <DisclosureTrigger className="text-xs">{t("settings.auditTechnical")}</DisclosureTrigger>
          <DisclosureContent>
            <p className="pb-1 font-mono text-[11px] text-muted-foreground">
              {t("settings.auditCorrelation", { id: evidence[0].correlationId })}
            </p>
          </DisclosureContent>
        </Disclosure>
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
      <Badge tone="warning" appearance="outline">
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
  if (actor.kind === "system") {
    return t("settings.auditActorSystem");
  }
  return actor.label;
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

function evidenceReasonText(event: AuditEvent, t: Translate): string | undefined {
  const reason = auditEventReason(event);
  return reason ? auditReasonText(reason, t) : undefined;
}
