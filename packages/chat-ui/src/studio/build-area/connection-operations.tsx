import type { ConnectionOperationDetail } from "@work-shape/catalyst-api-client";
import { CONNECTION_EXPOSURES } from "@work-shape/catalyst-core";
import {
  Badge,
  Button,
  Checkbox,
  Chip,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  EmptyState,
  List,
  Switch,
  type BadgeTone
} from "@work-shape/catalyst-ui";
import type { ReactNode } from "react";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type { BuildAsset, BuildAssetEditorProps } from "./build-asset-kind";
import { operationTitle } from "./connection-approval-model";
import { useConnectionWrite } from "./connection-editing";
import { OperationDetails } from "./connection-operation-details";
import { operationPagingText } from "./connection-paging";
import { RefusalNotice } from "./refusal-notice";
import {
  withOperationEnabled,
  withOperationExposure,
  withReviewedOperation,
  withoutOperation
} from "./connection-form-model";

// The accepted operations of a Connection, as what agents may do with it: a row names one, says
// whether it reads or changes, and what it does. What it calls and takes, who else may call it
// and the way to take it off are folded under "Details". On a Connection made on the instance,
// a reader who may change it switches an operation off or on in its row, or accepts the new
// description of one the server changed.

const OPERATION_STATUS: Record<
  ConnectionOperationDetail["status"],
  { tone: BadgeTone; label: TranslationKey; text?: TranslationKey }
> = {
  ready: { tone: "success", label: "connections.statusReady" },
  awaiting_discovery: {
    tone: "neutral",
    label: "connections.statusAwaitingDiscovery",
    text: "connections.statusAwaitingDiscoveryText"
  },
  needs_review: {
    tone: "warning",
    label: "connections.statusNeedsReview",
    text: "connections.statusNeedsReviewText"
  },
  unknown: {
    tone: "danger",
    label: "connections.statusUnknown",
    text: "connections.statusUnknownText"
  },
  disabled: {
    tone: "neutral",
    label: "connections.statusDisabled",
    text: "connections.statusDisabledText"
  }
};

type Exposure = ConnectionOperationDetail["exposure"][number];

/** Who may call an operation, in the order the page offers it: `outside` only here. */
const EXPOSURES: readonly Exposure[] = [...CONNECTION_EXPOSURES];

const EXPOSURE_LABELS: Record<Exposure, TranslationKey> = {
  agent: "connections.exposureAgent",
  bridge: "connections.exposureBridge",
  workflow: "connections.exposureWorkflow",
  outside: "connections.exposureOutside"
};

/**
 * The accepted operations of a Connection made on the instance, each with the way to take it
 * off, to open it to agents, Apps, Workflows or outside clients or close it again and, where
 * the server now describes it differently, to accept the new description.
 */
export function EditableOperations({
  asset,
  frame,
  operations,
  exposures: allowed = EXPOSURES,
  written
}: {
  asset: BuildAsset;
  frame: BuildAssetEditorProps;
  operations: ConnectionOperationDetail[];
  /**
   * Who the Connector type lets call its operations, such as agents alone for a type whose
   * results only its caller may read. One already chosen still shows, to be taken back.
   */
  exposures?: readonly Exposure[];
  written(): void;
}) {
  const { t } = useTranslation();
  const write = useConnectionWrite(frame, written);
  const blocked = frame.saveBlocked === true || write.saving !== undefined;
  return (
    <>
      <ConnectionOperations
        operations={operations}
        config={asset.config}
        control={(operation) => (
          <Switch
            aria-label={t("connectionPage.operationSwitch", {
              name: operationTitle(operation.name)
            })}
            checked={operation.enabled}
            disabled={blocked}
            data-connection-enabled={operation.name}
            onCheckedChange={(enabled) => {
              write
                .write(
                  `enabled:${operation.name}`,
                  withOperationEnabled(asset.config, operation.name, enabled)
                )
                .catch(() => undefined);
            }}
          />
        )}
        review={(operation) =>
          operation.status === "needs_review" && operation.discoveredFingerprint ? (
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              disabled={blocked}
              loading={write.saving === `review:${operation.name}`}
              onClick={() => {
                const fingerprint = operation.discoveredFingerprint ?? "";
                write
                  .write(
                    `review:${operation.name}`,
                    withReviewedOperation(asset.config, operation.name, fingerprint)
                  )
                  .catch(() => undefined);
              }}
            >
              {t("connections.acceptNewDescription")}
            </Button>
          ) : null
        }
        more={(operation) => (
          <div className="grid min-w-0 justify-items-start gap-3">
            <div
              role="group"
              aria-label={t("connections.operationExposure")}
              className="flex w-full min-w-0 flex-wrap items-start gap-x-5 gap-y-2"
            >
              {EXPOSURES.filter(
                (exposure) => allowed.includes(exposure) || operation.exposure.includes(exposure)
              ).map((exposure) => (
                <Checkbox
                  key={exposure}
                  label={t(
                    exposure === "outside" ? "connections.exposeOutside" : EXPOSURE_LABELS[exposure]
                  )}
                  // What leaving the instance means is said only once an outside client may call.
                  description={
                    exposure === "outside" && operation.exposure.includes("outside")
                      ? t("connections.exposeOutsideHint")
                      : undefined
                  }
                  checked={operation.exposure.includes(exposure)}
                  disabled={blocked}
                  data-connection-exposure={`${exposure}:${operation.name}`}
                  {...(exposure === "outside" ? { "data-connection-outside": operation.name } : {})}
                  onCheckedChange={(exposed) => {
                    write
                      .write(
                        `${exposure}:${operation.name}`,
                        withOperationExposure(asset.config, operation.name, exposure, exposed)
                      )
                      .catch(() => undefined);
                  }}
                />
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={blocked}
              loading={write.saving === `remove:${operation.name}`}
              data-connection-remove={operation.name}
              onClick={() => {
                write
                  .write(`remove:${operation.name}`, withoutOperation(asset.config, operation.name))
                  .catch(() => undefined);
              }}
            >
              {t("connections.removeOperation")}
            </Button>
          </div>
        )}
      />
      {write.failure ? <RefusalNotice {...write.failure} /> : null}
    </>
  );
}

export function ConnectionOperations({
  operations,
  config,
  control,
  review,
  more
}: {
  operations: ConnectionOperationDetail[];
  /** The Connection's definition: a REST API declares there what each operation sends. */
  config: Record<string, unknown>;
  /** The one control of a row, at its end: the switch that turns the operation off or on. */
  control?: (operation: ConnectionOperationDetail) => ReactNode;
  /** What the reader does about an operation that waits, under the sentence that says so. */
  review?: (operation: ConnectionOperationDetail) => ReactNode;
  /** What else the reader may do to one operation, folded under Details. */
  more?: (operation: ConnectionOperationDetail) => ReactNode;
}) {
  const { locale, t } = useTranslation();
  if (operations.length === 0) {
    return <EmptyState layout="inline">{t("connections.operationsEmpty")}</EmptyState>;
  }
  return (
    <List aria-label={t("connectionPage.agentsMayTitle")}>
      {operations.map((operation) => {
        // An operation that is switched off is disabled, whatever the catalog says of it.
        const status = OPERATION_STATUS[operation.enabled ? operation.status : "disabled"];
        const shown = operation.enabled ? operation.status : "disabled";
        // Callable by agents alone is what the section says of every row: only another answer
        // is said in the row itself.
        const agentsOnly = operation.exposure.length === 1 && operation.exposure[0] === "agent";
        const exposure = (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
            {operation.exposure.length === 0 ? (
              t("connections.exposureNone")
            ) : (
              <>
                <span>{t("connections.operationExposure")}</span>
                {operation.exposure.map((surface) => (
                  <Chip key={surface} size="sm">
                    {t(EXPOSURE_LABELS[surface])}
                  </Chip>
                ))}
              </>
            )}
          </div>
        );
        return (
          <li
            key={operation.name}
            data-connection-operation={operation.name}
            className="grid min-w-0 gap-1.5 border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 text-label break-words">
                {operationTitle(operation.name)}
              </span>
              <Badge tone={operation.effect === "changing" ? "warning" : "neutral"}>
                {t(
                  operation.effect === "changing"
                    ? "connections.effectChanging"
                    : "connections.effectReading"
                )}
              </Badge>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {/* A row that is ready says nothing of it: only what is not ready is named. */}
                {shown === "ready" ? null : (
                  <Badge tone={status.tone} dot data-connection-operation-status={shown}>
                    {t(status.label)}
                  </Badge>
                )}
                {control?.(operation)}
              </span>
            </div>
            {operation.description ? (
              // A description to accept again is shown whole: the model of an agent that
              // carries the tool reads all of it, so whoever accepts it does too.
              <p
                className={
                  operation.status === "needs_review"
                    ? "max-h-40 overflow-y-auto text-body break-words whitespace-pre-line"
                    : "line-clamp-3 text-body whitespace-pre-line"
                }
              >
                {operation.description}
              </p>
            ) : null}
            {agentsOnly ? null : exposure}
            {status.text ? (
              <p className="text-caption text-muted-foreground">{t(status.text)}</p>
            ) : null}
            {review?.(operation)}
            <Disclosure>
              <DisclosureTrigger data-connection-operation-more={operation.name}>
                {t("connectionPage.operationMore")}
              </DisclosureTrigger>
              {/* Kept in the page while folded: what it holds is found by its name. */}
              <DisclosureContent keepMounted>
                <div className="grid min-w-0 gap-3 pb-1">
                  <OperationDetails operation={operation} config={config} />
                  {agentsOnly && more === undefined ? exposure : null}
                  {operation.paging ? (
                    <p
                      data-connection-paging={operation.name}
                      className="text-caption break-words text-muted-foreground"
                    >
                      {t("connections.paging")} {operationPagingText(operation.paging, t, locale)}
                    </p>
                  ) : null}
                  {operation.status === "needs_review" && operation.discoveredFingerprint ? (
                    <p className="text-caption text-muted-foreground">
                      {t("connections.statusNeedsReviewFingerprint")}{" "}
                      <code className="font-mono break-all">{operation.discoveredFingerprint}</code>
                    </p>
                  ) : null}
                  {more?.(operation)}
                </div>
              </DisclosureContent>
            </Disclosure>
          </li>
        );
      })}
    </List>
  );
}
