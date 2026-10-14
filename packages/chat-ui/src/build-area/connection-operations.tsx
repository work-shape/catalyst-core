import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Chip,
  EmptyState,
  FormNotice,
  List,
  type BadgeTone
} from "@vivd-catalyst/ui";
import type { ConnectionOperationDetail } from "@vivd-catalyst/api-client";
import { useTranslation, type TranslationKey } from "../i18n";
import type { BuildAsset, BuildAssetEditorProps } from "./build-asset-kind";
import { useConnectionWrite } from "./connection-editing";
import {
  withOperationExposure,
  withReviewedOperation,
  withoutOperation
} from "./connection-form-model";

// The accepted operations of a Connection: what each does, who may call it and whether it is
// callable now. On a Connection made on the instance, a reader who may change it takes an
// operation off here, or accepts the new description of one the server changed.

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

const EXPOSURE_LABELS: Record<ConnectionOperationDetail["exposure"][number], TranslationKey> = {
  agent: "connections.exposureAgent",
  bridge: "connections.exposureBridge",
  workflow: "connections.exposureWorkflow",
  outside: "connections.exposureOutside"
};

/**
 * The accepted operations of a Connection made on the instance, each with the way to take it
 * off, to open it to outside clients or close it again and, where the server now describes it
 * differently, to accept the new description.
 */
export function EditableOperations({
  asset,
  frame,
  operations,
  written
}: {
  asset: BuildAsset;
  frame: BuildAssetEditorProps;
  operations: ConnectionOperationDetail[];
  written(): void;
}) {
  const { t } = useTranslation();
  const write = useConnectionWrite(frame, written);
  const blocked = frame.saveBlocked === true || write.saving !== undefined;
  return (
    <>
      <ConnectionOperations
        operations={operations}
        actions={(operation) => (
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox
              label={t("connections.exposeOutside")}
              description={t("connections.exposeOutsideHint")}
              checked={operation.exposure.includes("outside")}
              disabled={blocked}
              data-connection-outside={operation.name}
              onCheckedChange={(exposed) => {
                write
                  .write(
                    `outside:${operation.name}`,
                    withOperationExposure(asset.config, operation.name, "outside", exposed)
                  )
                  .catch(() => undefined);
              }}
            />
            {operation.status === "needs_review" && operation.discoveredFingerprint ? (
              <Button
                size="sm"
                variant="outline"
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
            ) : null}
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
      {write.failure ? <FormNotice tone="error">{write.failure}</FormNotice> : null}
    </>
  );
}

/**
 * An operation as a person reads it: its name in sentence case, such as "List customers" for
 * `list_customers`. The outside system names operations; it gives them no title for people.
 */
function operationTitle(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_.-]+/gu, " ")
    .trim()
    .toLowerCase();
  return words === "" ? name : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

export function ConnectionOperations({
  operations,
  actions
}: {
  operations: ConnectionOperationDetail[];
  /** What the reader may do to one operation, below it. */
  actions?: (operation: ConnectionOperationDetail) => ReactNode;
}) {
  const { t } = useTranslation();
  if (operations.length === 0) {
    return <EmptyState layout="inline">{t("connections.operationsEmpty")}</EmptyState>;
  }
  return (
    <List aria-label={t("connections.operationsTitle")}>
      {operations.map((operation) => {
        // An operation that is switched off is disabled, whatever the catalog says of it.
        const status = OPERATION_STATUS[operation.enabled ? operation.status : "disabled"];
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
              <Badge tone={status.tone} dot className="ml-auto">
                {t(status.label)}
              </Badge>
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
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
              {operation.exposure.length === 0 ? (
                t("connections.exposureNone")
              ) : (
                <>
                  <span>{t("connections.operationExposure")}</span>
                  {operation.exposure.map((exposure) => (
                    <Chip key={exposure} size="sm">
                      {t(EXPOSURE_LABELS[exposure])}
                    </Chip>
                  ))}
                </>
              )}
            </div>
            {status.text ? (
              <p className="text-caption text-muted-foreground">
                {t(status.text)}
                {operation.status === "needs_review" && operation.discoveredFingerprint ? (
                  <>
                    {" "}
                    {t("connections.statusNeedsReviewFingerprint")}{" "}
                    <code className="font-mono break-all">{operation.discoveredFingerprint}</code>
                  </>
                ) : null}
              </p>
            ) : null}
            {actions?.(operation)}
          </li>
        );
      })}
    </List>
  );
}
