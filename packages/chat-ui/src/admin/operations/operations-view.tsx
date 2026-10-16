import { Search } from "lucide-react";
import type { ReactNode } from "react";
import type { OperationRunResource } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  FilterBar,
  Input,
  KeyValue,
  KeyValueList,
  Select,
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow,
  cn
} from "@work-shape/catalyst-ui";
import { formatDateTime } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import {
  defaultOperationRunFilter,
  formatOperationRunDuration,
  isOperationRunFilterDefault,
  operationDecisionLabelKey,
  operationEffectFilterLabelKeys,
  operationOriginLabelKeys,
  operationRunAgentName,
  operationRunApp,
  operationRunEffectOf,
  operationRunEffects,
  operationRunOriginFields,
  operationRunOriginKindOf,
  operationRunOriginKinds,
  operationRunStatusBadge,
  operationRunStatusOf,
  operationRunStatuses,
  operationRunWorkspaceLabel,
  operationStatusLabelKeys,
  type OperationRunAppFacts,
  type OperationRunFilter
} from "../../shared/operations-model";

/** What a cell shows where the run has no value for it. */
const NO_VALUE = "–";

/** A workspace the viewer can name. */
export interface OperationRunWorkspace {
  id: string;
  name: string;
}

/** The filters above the list. The workspace filter shows only to a viewer who has workspaces. */
export function OperationRunFilters({
  filter,
  workspaces,
  onChange
}: {
  filter: OperationRunFilter;
  workspaces: readonly OperationRunWorkspace[];
  onChange(filter: OperationRunFilter): void;
}) {
  const { t } = useTranslation();
  return (
    <FilterBar
      data-operation-run-filters
      search={
        <Input
          type="search"
          className="font-mono"
          leadingIcon={<Search aria-hidden="true" />}
          placeholder={t("operations.filterOperation")}
          aria-label={t("operations.filterOperation")}
          value={filter.operation}
          onChange={(event) => onChange({ ...filter, operation: event.target.value })}
        />
      }
      filters={
        <>
          <Select
            className="w-full font-medium sm:w-44"
            aria-label={t("operations.filterEffect")}
            data-operation-run-effect-filter
            value={filter.effect ?? ""}
            onChange={(event) =>
              onChange({ ...filter, effect: operationRunEffectOf(event.target.value) })
            }
          >
            {operationRunEffects.map((effect) => (
              <option key={effect} value={effect}>
                {t(operationEffectFilterLabelKeys[effect])}
              </option>
            ))}
            <option value="">{t("operations.allEffects")}</option>
          </Select>
          <Select
            className="w-full font-medium sm:w-52"
            aria-label={t("operations.filterStatus")}
            value={filter.status ?? ""}
            onChange={(event) =>
              onChange({ ...filter, status: operationRunStatusOf(event.target.value) })
            }
          >
            <option value="">{t("allStatuses")}</option>
            {operationRunStatuses.map((status) => (
              <option key={status} value={status}>
                {t(operationStatusLabelKeys[status])}
              </option>
            ))}
          </Select>
          <Select
            className="w-full font-medium sm:w-40"
            aria-label={t("operations.filterOrigin")}
            value={filter.origin ?? ""}
            onChange={(event) =>
              onChange({ ...filter, origin: operationRunOriginKindOf(event.target.value) })
            }
          >
            <option value="">{t("operations.allOrigins")}</option>
            {operationRunOriginKinds.map((kind) => (
              <option key={kind} value={kind}>
                {t(operationOriginLabelKeys[kind])}
              </option>
            ))}
          </Select>
          {workspaces.length === 0 ? null : (
            <Select
              className="w-full font-medium sm:w-48"
              aria-label={t("operations.filterWorkspace")}
              value={filter.workspaceId ?? ""}
              onChange={(event) =>
                onChange({ ...filter, workspaceId: event.target.value || undefined })
              }
            >
              <option value="">{t("operations.allWorkspaces")}</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </Select>
          )}
        </>
      }
      actions={
        isOperationRunFilterDefault(filter) ? undefined : (
          <Button variant="ghost" size="sm" onClick={() => onChange(defaultOperationRunFilter)}>
            {t("operations.clearFilters")}
          </Button>
        )
      }
    />
  );
}

/**
 * The runs, newest first. Seven facts in five columns: where the call came from stands under
 * who called, and how long it took under when it started.
 */
export function OperationRunsTable({
  runs,
  workspaces,
  onOpen
}: {
  runs: readonly OperationRunResource[];
  workspaces: readonly OperationRunWorkspace[];
  onOpen(run: OperationRunResource): void;
}) {
  const { t, locale } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("operations.operation")}</TableHead>
          <TableHead>{t("operations.actor")}</TableHead>
          <TableHead>{t("operations.workspace")}</TableHead>
          <TableHead>{t("operations.status")}</TableHead>
          <TableHead>{t("operations.started")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const agentName = operationRunAgentName(run.origin);
          const app = operationRunApp(run);
          return (
            <TableRow key={run.id} data-operation-run-id={run.id} data-status={run.status}>
              <TableCell>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-left font-mono wrap-anywhere whitespace-normal text-foreground"
                  aria-label={t("operations.showRun", { operation: run.operation })}
                  onClick={() => onOpen(run)}
                >
                  {run.operation}
                </Button>
              </TableCell>
              <TableCell>
                {run.actor.label}
                <TableCellDetail
                  data-origin={run.origin.kind}
                  data-origin-app={app ? (app.deleted ? "deleted" : "active") : undefined}
                >
                  <span className="sr-only">{t("operations.origin")}: </span>
                  {agentName
                    ? t("operations.throughAgent", { agent: agentName })
                    : t(operationOriginLabelKeys[run.origin.kind])}
                  {app ? ` · ${operationRunAppText(app, t)}` : null}
                </TableCellDetail>
              </TableCell>
              <TableCell className="wrap-anywhere" data-workspace-id={run.workspaceId}>
                {operationRunWorkspaceLabel(run.workspaceId, workspaces) ?? (
                  <span className="text-muted-foreground">{NO_VALUE}</span>
                )}
              </TableCell>
              <TableCell>
                <OperationRunStatus run={run} />
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDateTime(run.startedAt ?? run.createdAt, locale)}
                <TableCellDetail data-duration>
                  <span className="sr-only">{t("operations.duration")}: </span>
                  {formatOperationRunDuration(run, locale) ?? NO_VALUE}
                </TableCellDetail>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function OperationRunStatus({ run }: { run: OperationRunResource }) {
  const { t } = useTranslation();
  const { labelKey, tone } = operationRunStatusBadge(run);
  return (
    <Badge tone={tone} dot>
      {t(labelKey)}
    </Badge>
  );
}

/**
 * Everything the record of one run holds. It names the input by its hash: the record has
 * neither the input nor what the call answered, and this view shows neither.
 */
export function OperationRunDetail({
  run,
  workspaces,
  approvalRequestHref
}: {
  run: OperationRunResource;
  workspaces: readonly OperationRunWorkspace[];
  /** Where the request another person decides is read, for a run that has one. */
  approvalRequestHref?: string;
}) {
  const { t, locale } = useTranslation();
  const { decision, error, usage } = run;
  const app = operationRunApp(run);
  const time = (value: string | undefined) =>
    value === undefined ? undefined : formatDateTime(value, locale);
  const count = (value: number) => value.toLocaleString(locale);

  return (
    <KeyValueList data-operation-run-detail={run.id}>
      <Fact name="operation" label={t("operations.operation")} mono>
        {run.operation}
      </Fact>
      <Fact name="status" label={t("operations.status")}>
        <OperationRunStatus run={run} />
      </Fact>
      <Fact name="effect" label={t("operations.effect")}>
        {t(run.effect === "reading" ? "operations.effectReading" : "operations.effectChanging")}
      </Fact>
      <Fact name="actor" label={t("operations.actor")}>
        {run.actor.label}
        <Detail>
          {t(
            run.actor.kind === "user" ? "operations.actorUser" : "operations.actorServicePrincipal"
          )}
        </Detail>
      </Fact>
      <Fact name="origin" label={t("operations.origin")}>
        {t(operationOriginLabelKeys[run.origin.kind])}
      </Fact>
      {app ? (
        <Fact name="origin.app" label={t("operations.fieldApp")}>
          {app.deleted ? t("operations.appDeleted", { id: app.name }) : app.name}
          {app.revision === undefined ? null : (
            <Detail>{t("operations.appRevision", { number: app.revision })}</Detail>
          )}
        </Fact>
      ) : null}
      {app?.target ? (
        <Fact name="origin.target" label={t("operations.fieldTarget")}>
          {app.target.name}
          <span aria-hidden="true" className="text-muted-foreground">
            {" · "}
          </span>
          <span className="font-mono text-code">{app.target.operation}</span>
        </Fact>
      ) : null}
      {operationRunOriginFields(run.origin).map((entry) => (
        <Fact key={entry.field} name={`origin.${entry.field}`} label={t(entry.labelKey)} mono>
          {entry.value}
        </Fact>
      ))}
      <Fact name="workspace" label={t("operations.workspace")}>
        {operationRunWorkspaceLabel(run.workspaceId, workspaces)}
      </Fact>
      {decision ? (
        <Fact name="decision" label={t("operations.decision")}>
          {t(operationDecisionLabelKey(decision))}
          <Detail>
            {decision.byLabel ?? decision.by}, {formatDateTime(decision.at, locale)}
          </Detail>
        </Fact>
      ) : null}
      {decision?.comment ? (
        <Fact name="decision.comment" label={t("operations.decisionComment")}>
          <span className="whitespace-pre-wrap">{decision.comment}</span>
        </Fact>
      ) : null}
      {approvalRequestHref ? (
        <Fact name="approvalRequest" label={t("operations.approvalRequest")}>
          <Button asChild variant="link" size="sm" className="h-auto px-0">
            <a href={approvalRequestHref} data-approval-request-link>
              {t("operations.openApprovalRequest")}
            </a>
          </Button>
        </Fact>
      ) : null}
      {error ? (
        <Fact name="error" label={t("operations.error")}>
          <span className="font-mono text-code">{error.code}</span>
          <Detail className="whitespace-pre-wrap">{error.message}</Detail>
        </Fact>
      ) : null}
      {usage ? (
        <>
          <Fact name="usage.modelCalls" label={t("operations.usageModelCalls")}>
            {count(usage.modelCalls)}
          </Fact>
          <Fact name="usage.inputTokens" label={t("operations.usageInputTokens")}>
            {count(usage.inputTokens)}
          </Fact>
          <Fact name="usage.outputTokens" label={t("operations.usageOutputTokens")}>
            {count(usage.outputTokens)}
          </Fact>
          <Fact name="usage.totalTokens" label={t("operations.usageTotalTokens")}>
            {count(usage.totalTokens)}
          </Fact>
        </>
      ) : null}
      <Fact
        name="correlationId"
        label={t("operations.correlationId")}
        mono
        copyValue={run.correlationId}
      >
        {run.correlationId}
      </Fact>
      <Fact name="inputHash" label={t("operations.inputHash")} mono>
        {run.inputHash}
      </Fact>
      <Fact name="attempt" label={t("operations.attempt")}>
        {count(run.attempt)}
      </Fact>
      <Fact name="createdAt" label={t("operations.created")}>
        {time(run.createdAt)}
      </Fact>
      <Fact name="startedAt" label={t("operations.started")}>
        {time(run.startedAt)}
      </Fact>
      <Fact name="finishedAt" label={t("operations.finished")}>
        {time(run.finishedAt)}
      </Fact>
      <Fact name="duration" label={t("operations.duration")}>
        {formatOperationRunDuration(run, locale)}
      </Fact>
      <Fact name="expiresAt" label={t("operations.expires")}>
        {time(run.expiresAt)}
      </Fact>
    </KeyValueList>
  );
}

/** The App of a call in one line: its name, the revision where it is known, and the action. */
function operationRunAppText(
  app: OperationRunAppFacts,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  const name = app.deleted ? t("operations.appDeleted", { id: app.name }) : app.name;
  return [
    name,
    ...(app.revision === undefined ? [] : [t("operations.appRevision", { number: app.revision })]),
    app.action
  ].join(" · ");
}

/** One labelled fact of a run. A fact the run does not have is left out. */
function Fact({
  name,
  label,
  mono = false,
  copyValue,
  children
}: {
  name: string;
  label: string;
  mono?: boolean;
  copyValue?: string;
  children: ReactNode;
}) {
  if (children === undefined || children === null) {
    return null;
  }
  return (
    <KeyValue label={label} copyValue={copyValue} data-field={name}>
      {mono ? <span className="font-mono text-code wrap-anywhere">{children}</span> : children}
    </KeyValue>
  );
}

/** A second line under a fact: what belongs to it and matters less. */
function Detail({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("block text-caption text-muted-foreground", className)}>{children}</span>
  );
}
