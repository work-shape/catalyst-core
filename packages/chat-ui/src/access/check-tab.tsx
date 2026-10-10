import { useState } from "react";
import type {
  AdministeredUser,
  ConfigAssetSummary,
  EffectivePermissions,
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
  checkAsset,
  checkedAssetId,
  type AccessAssetKind,
  type CheckedAction
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
  /** The active agents and skills, for the id an asset row names. */
  assets: readonly ConfigAssetSummary[] | undefined;
  holderId: string | undefined;
  onHolderChange(holderId: string): void;
  /** What the chosen user is allowed and denied. Absent while it loads. */
  effective: EffectivePermissions | undefined;
  /** `hidden` when the server does not show the caller this user. */
  effectiveFailure: "hidden" | "failed" | undefined;
  onRetry(): void;
  /** The grant rows the chosen user holds: they name assets that were deleted, too. */
  holderGrants: readonly PermissionGrantRow[];
}

/** What one person may do with one agent or skill, per action, with what decided it. */
export function CheckTab({
  users,
  usersFailed,
  assets,
  holderId,
  onHolderChange,
  effective,
  effectiveFailure,
  onRetry,
  holderGrants
}: CheckTabProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<AccessAssetKind>("agent");
  const [name, setName] = useState("");
  const holder = users?.find((user) => user.id === holderId);
  const assetName = name.trim();
  const kindAssets = (assets ?? []).filter((asset) => asset.kind === kind);
  const asked = holderId !== undefined && assetName !== "";

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
        <Field label={t("access.checkName")} className="sm:col-span-2">
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
      {!asked ? (
        <EmptyState>{t("access.checkEmpty")}</EmptyState>
      ) : effectiveFailure === "hidden" ? (
        <Banner tone="danger">{t("access.checkHolderHidden")}</Banner>
      ) : effectiveFailure === "failed" ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("tryAgain")}
            </Button>
          }
        >
          {t("access.checkLoadFailed")}
        </Banner>
      ) : effective === undefined ? (
        <SkeletonList rows={3} />
      ) : (
        <CheckResult
          holderName={holder?.displayLabel ?? t("access.unknownUser")}
          assetName={assetName}
          effective={effective}
          actions={checkAsset(
            effective,
            { kind, name: assetName },
            checkedAssetId({ kind, name: assetName }, assets ?? [], holderGrants)
          )}
        />
      )}
    </div>
  );
}

function CheckResult({
  holderName,
  assetName,
  effective,
  actions
}: {
  holderName: string;
  assetName: string;
  effective: EffectivePermissions;
  actions: readonly CheckedAction[];
}) {
  const { t } = useTranslation();
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
        {actions.some((action) => action.reason === "deny") ? (
          <Banner layout="line">{t("access.checkInstanceRightsNote")}</Banner>
        ) : null}
      </div>
    </Section>
  );
}
