import { useState } from "react";
import type {
  AdministeredUser,
  ConfigAssetSummary,
  EffectivePermissions,
  NamespaceWithUsage,
  PermissionGrantRow
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  Picker,
  PickerButton,
  Section,
  Select,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@vivd-catalyst/ui";
import { useTranslation, type TranslationContextValue, type TranslationKey } from "../i18n";
import {
  ACCESS_ASSET_KINDS,
  assetNameValid,
  checkAsset,
  checkedAssetId,
  checkState,
  namespaceOfName,
  type AccessAssetKind,
  type CheckedAction,
  type LoadFailure
} from "./access-model";
import { kindLabelKeys, verbLabelKeys } from "./grants-tab";

/** From this many entries on, a picker of the check shows its search field. */
const PICKER_SEARCH_FROM_COUNT = 8;

type Translate = TranslationContextValue["t"];

const reasonLabelKeys: Record<CheckedAction["reason"], TranslationKey> = {
  role: "access.reasonRole",
  legacy: "access.reasonLegacy",
  grant: "access.reasonGrant",
  deny: "access.reasonDeny",
  no_grant: "access.reasonNoGrant",
  holder_inactive: "access.reasonHolderInactive"
};

/** The entry that decided, as one sentence. */
function decidedBy(action: CheckedAction, t: Translate): string {
  const { entry } = action;
  if (action.reason === "holder_inactive") {
    return t("access.reasonHolderInactive");
  }
  if (!entry) {
    return t("access.decidedByNothing");
  }
  if (entry.source === "role") {
    return t("access.decidedByRole");
  }
  if (entry.source !== "grant") {
    return t(entry.effect === "deny" ? "access.decidedByLegacyDeny" : "access.decidedByLegacy");
  }
  const row =
    entry.scopeKind === "namespace"
      ? t(
          entry.effect === "deny"
            ? "access.decidedByDenyNamespace"
            : "access.decidedByGrantNamespace",
          { prefix: entry.namespace ?? "" }
        )
      : t(entry.effect === "deny" ? "access.decidedByDenyAsset" : "access.decidedByGrantAsset");
  return action.deniedThrough === undefined
    ? row
    : t("access.decidedByDenyThrough", {
        deny: row,
        action: t(verbLabelKeys[action.deniedThrough])
      });
}

export interface CheckTabProps {
  /** The users the caller is shown. Absent while they load and when they could not be loaded. */
  users: readonly AdministeredUser[] | undefined;
  usersFailed: boolean;
  /** The active agents and skills, for the id an asset row names. Absent until they loaded. */
  assets: readonly ConfigAssetSummary[] | undefined;
  /** Why the agents and skills are absent for good; without them no result is shown. */
  assetsFailure: LoadFailure | undefined;
  onRetryAssets(): void;
  /** The Namespaces, for the lists that bind a save. Absent while they load or failed. */
  namespaces: readonly NamespaceWithUsage[] | undefined;
  /** The models of the instance, for the names of the ones a Namespace lists. */
  modelBindings: readonly { id: string; model: string }[] | undefined;
  holderId: string | undefined;
  onHolderChange(holderId: string): void;
  /** What the chosen user is allowed and denied. Absent while it loads. */
  effective: EffectivePermissions | undefined;
  /** `hidden` when the server does not show the caller this user. */
  effectiveFailure: "hidden" | "failed" | undefined;
  onRetry(): void;
  /**
   * The grant rows the chosen user holds: they name assets that were deleted, too. Absent
   * until the grants loaded; without them a deny on a deleted asset would be missed.
   */
  holderGrants: readonly PermissionGrantRow[] | undefined;
  grantsFailed: boolean;
  onRetryGrants(): void;
}

/** What one person may do with one agent or skill, per action, with what decided it. */
export function CheckTab({
  users,
  usersFailed,
  assets,
  assetsFailure,
  onRetryAssets,
  namespaces,
  modelBindings,
  holderId,
  onHolderChange,
  effective,
  effectiveFailure,
  onRetry,
  holderGrants,
  grantsFailed,
  onRetryGrants
}: CheckTabProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<AccessAssetKind>("agent");
  const [name, setName] = useState("");
  const holder = users?.find((user) => user.id === holderId);
  const assetName = name.trim();
  const kindAssets = (assets ?? []).filter((asset) => asset.kind === kind);
  const nameValid = assetNameValid(kind, assetName);
  const state = checkState({
    holderId,
    kind,
    name: assetName,
    effectiveLoaded: effective !== undefined,
    effectiveFailure,
    grantsLoaded: holderGrants !== undefined,
    grantsFailed,
    assetsLoaded: assets !== undefined,
    assetsFailure
  });
  const retryBanner = (text: string, retry: () => void) => (
    <Banner
      tone="danger"
      action={
        <Button size="sm" variant="outline" onClick={retry}>
          {t("tryAgain")}
        </Button>
      }
    >
      {text}
    </Banner>
  );

  return (
    <div className="grid gap-6">
      <p className="text-body text-muted-foreground">{t("access.checkDescription")}</p>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field
          label={t("access.checkPerson")}
          error={usersFailed ? t("access.usersLoadFailed") : undefined}
        >
          <Picker
            search={(users?.length ?? 0) >= PICKER_SEARCH_FROM_COUNT}
            options={(users ?? []).map((user) => ({
              value: user.id,
              label: user.displayLabel,
              description: user.email
            }))}
            value={holderId}
            onValueChange={onHolderChange}
          >
            <PickerButton
              label={t("access.checkPerson")}
              placeholder={t("access.choosePerson")}
              value={holder?.displayLabel}
              disabled={users === undefined}
            />
          </Picker>
        </Field>
        <Field label={t("access.checkKind")}>
          <Select
            value={kind}
            onChange={(event) => {
              const next = ACCESS_ASSET_KINDS.find(
                (candidate) => candidate === event.currentTarget.value
              );
              if (next) {
                setKind(next);
              }
            }}
          >
            {ACCESS_ASSET_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(kindLabelKeys[candidate])}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t("access.checkName")}
          className="sm:col-span-2"
          error={
            assetName === "" || nameValid
              ? undefined
              : t(
                  kind === "agent" ? "access.checkNameInvalidAgent" : "access.checkNameInvalidSkill"
                )
          }
        >
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-48 flex-1 font-mono"
              value={name}
              placeholder={t("access.checkNamePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            {kindAssets.length > 0 ? (
              <Picker
                align="end"
                search={kindAssets.length >= PICKER_SEARCH_FROM_COUNT}
                options={kindAssets.map((asset) => ({ value: asset.name, label: asset.name }))}
                value={kindAssets.some((asset) => asset.name === assetName) ? assetName : undefined}
                onValueChange={setName}
              >
                <Button variant="outline">{t("access.checkPickAsset")}</Button>
              </Picker>
            ) : null}
          </div>
        </Field>
      </div>
      {/* A result needs the person's rights, the grant rows and the assets: a missing part is
          said, because a result without it could call a denied action allowed. */}
      {state === "incomplete" ? (
        <EmptyState>{t("access.checkEmpty")}</EmptyState>
      ) : state === "holderHidden" ? (
        <Banner tone="danger">{t("access.checkHolderHidden")}</Banner>
      ) : state === "effectiveFailed" ? (
        retryBanner(t("access.checkLoadFailed"), onRetry)
      ) : state === "grantsFailed" ? (
        retryBanner(t("access.checkGrantsFailed"), onRetryGrants)
      ) : state === "assetsForbidden" ? (
        <Banner tone="warning">{t("access.checkAssetsForbidden")}</Banner>
      ) : state === "assetsFailed" ? (
        retryBanner(t("access.checkAssetsFailed"), onRetryAssets)
      ) : effective === undefined || holderGrants === undefined || assets === undefined ? (
        <SkeletonList rows={3} />
      ) : (
        <CheckResult
          holderName={holder?.displayLabel ?? t("access.unknownUser")}
          kind={kind}
          assetName={assetName}
          effective={effective}
          namespace={namespaceOfName(assetName, namespaces ?? [])}
          modelBindings={modelBindings}
          actions={checkAsset(
            effective,
            { kind, name: assetName },
            checkedAssetId({ kind, name: assetName }, assets, holderGrants)
          )}
        />
      )}
    </div>
  );
}

/**
 * What the lists of a Namespace say about an agent in it, one sentence per list. Nothing for a
 * skill and for a Namespace without lists: lists bind agents only.
 */
function namespaceLimits(
  kind: AccessAssetKind,
  namespace: NamespaceWithUsage | undefined,
  modelBindings: readonly { id: string; model: string }[] | undefined,
  t: Translate
): string[] {
  const tools = namespace?.allowedToolNames;
  const models = namespace?.allowedModelBindingIds;
  if (kind !== "agent" || !namespace || (!tools && !models)) {
    return [];
  }
  const modelName = (id: string) =>
    modelBindings?.find((binding) => binding.id === id)?.model ?? id;
  return [
    t("access.checkNamespace", { prefix: namespace.prefix }),
    ...(tools
      ? [
          tools.length === 0
            ? t("access.checkToolsNone")
            : t("access.checkToolsListed", { list: tools.join(", ") })
        ]
      : []),
    ...(models
      ? [
          models.length === 0
            ? t("access.checkModelsNone")
            : t("access.checkModelsListed", { list: models.map(modelName).join(", ") })
        ]
      : [])
  ];
}

function CheckResult({
  holderName,
  kind,
  assetName,
  effective,
  namespace,
  modelBindings,
  actions
}: {
  holderName: string;
  kind: AccessAssetKind;
  assetName: string;
  effective: EffectivePermissions;
  namespace: NamespaceWithUsage | undefined;
  modelBindings: readonly { id: string; model: string }[] | undefined;
  actions: readonly CheckedAction[];
}) {
  const { t } = useTranslation();
  const allowed = (verb: CheckedAction["verb"]) =>
    actions.find((action) => action.verb === verb && action.allowed);
  const limits = allowed("write") ? namespaceLimits(kind, namespace, modelBindings, t) : [];
  return (
    <Section
      layout="stacked"
      title={t("access.checkResult", { name: holderName, asset: assetName })}
    >
      <div className="grid gap-3">
        {effective.holderActive ? null : (
          <Banner tone="warning">{t("access.checkHolderInactive")}</Banner>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("access.grantAction")}</TableHead>
              <TableHead>{t("access.checkDecision")}</TableHead>
              <TableHead>{t("access.checkDecidedBy")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {actions.map((action) => (
              <TableRow key={action.verb} data-testid="check-row" data-verb={action.verb}>
                <TableCell>{t(verbLabelKeys[action.verb])}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={action.allowed ? "success" : "danger"}>
                      {t(action.allowed ? "access.checkAllowed" : "access.checkRefused")}
                    </Badge>
                    <Badge appearance="outline">{t(reasonLabelKeys[action.reason])}</Badge>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{decidedBy(action, t)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {/* The table answers for the right. What else refuses a save is said under it. */}
        {allowed("write") ? (
          <p data-testid="check-right-only" className="text-body text-muted-foreground">
            {t(kind === "agent" ? "access.checkRightOnlyAgent" : "access.checkRightOnlySkill")}
          </p>
        ) : null}
        {limits.length > 0 ? (
          <Banner tone="warning" data-testid="check-namespace-limits">
            {limits.join(" ")}
          </Banner>
        ) : null}
        {allowed("read")?.reason === "grant" ? (
          <Banner layout="line">{t("access.checkReadThroughGrant")}</Banner>
        ) : null}
        {actions.some((action) => action.reason === "deny") ? (
          <Banner layout="line">{t("access.checkDenyNote")}</Banner>
        ) : null}
      </div>
    </Section>
  );
}
