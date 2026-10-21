// @rights-screen: included in the rights wording guard.
import type {
  AccessOrigin,
  AdministeredUser,
  AssetRightsCheck,
  ConfigAssetSummary,
  PermissionGrantRow
} from "@work-shape/catalyst-api-client";
import { ASSET_OWNER_KINDS } from "@work-shape/catalyst-core";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
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
} from "@work-shape/catalyst-ui";
import { useState } from "react";
import { DocsReference } from "../../shared/docs-links";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import { refusalAskingInstanceAdmin } from "../settings/ask-instance-admin";
import {
  checkedActions,
  checkState,
  type CheckableAsset,
  type CheckedAction,
  type CheckedKind,
  type LoadFailure
} from "./access-model";
import { assetKindLabelKey } from "./grant-words";
import { onlyInLabel, originRoleName } from "./origin-words";
import { verbLabel } from "./right-words";

/** From this many entries on, a picker of the check shows its search field. */
const PICKER_SEARCH_FROM_COUNT = 8;

type Translate = TranslationContextValue["t"];

const reasonLabelKeys: Record<CheckedAction["reason"], TranslationKey> = {
  role: "access.reasonRole",
  legacy: "access.reasonLegacy",
  grant: "access.reasonGrant",
  membership: "access.reasonMembership",
  availability: "access.reasonAvailability",
  deny: "access.reasonDeny",
  no_grant: "access.reasonNoGrant",
  holder_inactive: "access.reasonHolderInactive"
};

/** Where the entry that decided lies, as the sentence of a role or a given right names it. */
function decidedPlace(entry: AccessOrigin): "Instance" | "Workspace" | "Asset" {
  return entry.scopeKind === "asset"
    ? "Asset"
    : entry.scopeKind === "workspace"
      ? "Workspace"
      : "Instance";
}

/** The entry that decided, as one sentence: the role by its name, a right by where it lies. */
function decidedBy(action: CheckedAction, t: Translate, roles: AssetRightsCheck["roles"]): string {
  const { entry } = action;
  if (action.reason === "holder_inactive") {
    return t("access.reasonHolderInactive");
  }
  if (action.availability === "instance") return t("access.decidedByAvailabilityInstance");
  if (action.availability === "self") {
    return t(
      action.allowed
        ? "access.decidedByAvailabilitySelfAllowed"
        : "access.decidedByAvailabilitySelfRefused"
    );
  }
  if (!entry) {
    return t("access.decidedByNothing");
  }
  const place = decidedPlace(entry);
  const deny = entry.effect === "deny";
  let sentence: string;
  if (entry.source === "role") {
    const role = originRoleName(entry.roleId, roles, t);
    sentence =
      role === undefined
        ? t("access.decidedByAnyRole")
        : deny
          ? t("access.decidedByRoleDeny", { role })
          : place === "Instance"
            ? t("access.decidedByRole", { role })
            : t(`access.decidedByRole${place}`, { role });
  } else if (entry.source === "membership" && !deny) {
    sentence = t(
      place === "Asset" ? "access.decidedByMembershipAsset" : "access.decidedByMembershipWorkspace"
    );
  } else if (entry.source === "legacy_ref") {
    sentence = t(deny ? "access.decidedByLegacyDeny" : "access.decidedByLegacy");
  } else {
    sentence = t(deny ? `access.decidedByDeny${place}` : `access.decidedByGrant${place}`);
  }
  return action.deniedThrough === undefined
    ? sentence
    : t("access.decidedByDenyThrough", {
        deny: sentence,
        action: verbLabel(action.deniedThrough, t)
      });
}

/** The name of a kind in the list: the page's own word, else the name the instance gives it. */
function kindLabel(kind: CheckedKind, t: Translate): string {
  const key = assetKindLabelKey(kind.kind);
  return key === undefined ? kind.plural : t(key);
}

/** The assets of one kind beyond agents and skills, as the page could list them. */
interface CheckKindAssets {
  /** Absent while they load. */
  items: readonly CheckableAsset[] | undefined;
  failure: LoadFailure | undefined;
  retry(): void;
}

export interface CheckTabProps {
  /**
   * The asset kinds of the instance with the actions each is checked as, from the instance's
   * registry. Absent until the instance has answered: agents and skills are offered meanwhile.
   */
  kinds: readonly CheckedKind[] | undefined;
  /** The assets of the chosen kind where it is no agent or skill. Asked for by `onKindChange`. */
  kindAssets: CheckKindAssets | undefined;
  onKindChange(kind: string): void;
  /** The users the caller is shown. Absent while they load and when they could not be loaded. */
  users: readonly AdministeredUser[] | undefined;
  usersFailed: boolean;
  /** The active agents and skills, for the id an asset row names. Absent until they loaded. */
  assets: readonly ConfigAssetSummary[] | undefined;
  /** Why the agents and skills are absent for good; without them no result is shown. */
  assetsFailure: LoadFailure | undefined;
  onRetryAssets(): void;
  holderId: string | undefined;
  onHolderChange(holderId: string): void;
  /** The chosen asset's name, picked from the assets of the chosen kind. */
  name: string;
  onNameChange(name: string): void;
  /**
   * The server's answer for the chosen user and asset, each right decided with the entry that
   * decides it. Absent while it loads and until a person and an asset are chosen.
   */
  check: AssetRightsCheck | undefined;
  /** `hidden` when the server does not show the caller this user. */
  checkFailure: "hidden" | "failed" | undefined;
  onRetry(): void;
  /**
   * The grant rows the chosen user holds: they name assets that were deleted, too. Absent
   * until the grants loaded; without them a deny on a deleted asset would be missed.
   */
  holderGrants: readonly PermissionGrantRow[] | undefined;
  grantsFailed: boolean;
  onRetryGrants(): void;
  /** An active instance admin, whom a refusal names as the one who can help. */
  instanceAdminName?: string;
  /** The title an asset is listed by in the reader's language, where the page knows it. */
  titleOf?(assetId: string): string | undefined;
}

/** The kinds every instance has, offered until the instance has named its own. */
const BUILT_IN_KINDS: readonly CheckedKind[] = [
  {
    kind: "agent",
    plural: "agents",
    lifecycle: "active",
    representation: "config",
    owners: [...ASSET_OWNER_KINDS],
    actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" }
  },
  {
    kind: "skill",
    plural: "skills",
    lifecycle: "active",
    representation: "config",
    owners: [...ASSET_OWNER_KINDS],
    actions: { read: "skill.read", write: "skill.write", delete: "skill.delete" }
  }
];

/** What one person may do with one asset of a kind, per action, with what decided it. */
export function CheckTab({
  kinds: reportedKinds,
  kindAssets: otherAssets,
  onKindChange,
  users,
  usersFailed,
  assets,
  assetsFailure,
  onRetryAssets,
  holderId,
  onHolderChange,
  name,
  onNameChange,
  check,
  checkFailure,
  onRetry,
  holderGrants,
  grantsFailed,
  onRetryGrants,
  instanceAdminName,
  titleOf
}: CheckTabProps) {
  const { t } = useTranslation();
  const kinds = reportedKinds ?? BUILT_IN_KINDS;
  const [kindId, setKindId] = useState("agent");
  const holder = users?.find((user) => user.id === holderId);
  const assetName = name.trim();
  const checkedKind = kinds.find((candidate) => candidate.kind === kindId) ?? kinds[0];
  const kind = checkedKind?.kind ?? kindId;
  // Agents and skills come with the agent configuration; every other kind has its own list.
  const fromOverview = kind === "agent" || kind === "skill";
  const loadedAssets: readonly CheckableAsset[] | undefined = fromOverview
    ? assets
    : otherAssets?.items;
  const kindAssets = (loadedAssets ?? []).filter((asset) => asset.kind === kind);
  const kindAssetsFailure = fromOverview ? assetsFailure : otherAssets?.failure;
  const picked = kindAssets.find((asset) => asset.name === assetName);
  // An asset is picked by the title the rows name it by, where the page knows it.
  const labelOf = (asset: CheckableAsset) =>
    (asset.id === undefined ? undefined : titleOf?.(asset.id)) ?? asset.name;
  const retryKindAssets = fromOverview ? onRetryAssets : (otherAssets?.retry ?? onRetryAssets);
  const state = checkState({
    holderId,
    kind: checkedKind?.kind,
    name: assetName,
    checkLoaded: check !== undefined,
    checkFailure,
    grantsLoaded: holderGrants !== undefined,
    grantsFailed,
    assetsLoaded: loadedAssets !== undefined,
    assetsFailure: kindAssetsFailure
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
      <p className="text-body text-muted-foreground">
        {t("access.checkDescription")} <DocsReference to="rightsCheck" />
      </p>
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
              const next = kinds.find((candidate) => candidate.kind === event.currentTarget.value);
              if (next) {
                setKindId(next.kind);
                // An asset belongs to its kind: the name of another kind's asset is not kept.
                onNameChange("");
                onKindChange(next.kind);
              }
            }}
          >
            {kinds.map((candidate) => (
              <option key={candidate.kind} value={candidate.kind}>
                {kindLabel(candidate, t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t("access.checkName")}
          className="sm:col-span-2"
          hint={
            loadedAssets !== undefined && kindAssets.length === 0 ? t("access.noAssets") : undefined
          }
        >
          <Picker
            search={kindAssets.length >= PICKER_SEARCH_FROM_COUNT}
            // The title first, with the name the asset goes by under it where they differ.
            options={kindAssets.map((asset) => {
              const label = labelOf(asset);
              return {
                value: asset.name,
                label,
                ...(label === asset.name ? {} : { description: asset.name })
              };
            })}
            value={kindAssets.some((asset) => asset.name === assetName) ? assetName : undefined}
            onValueChange={onNameChange}
          >
            <PickerButton
              label={t("access.checkName")}
              placeholder={t("access.chooseAsset")}
              value={picked === undefined ? undefined : labelOf(picked)}
              disabled={kindAssets.length === 0}
            />
          </Picker>
        </Field>
      </div>
      {/* A result needs the person's rights, the grant rows and the assets: a missing part is
          said, because a result without it could call a denied action allowed. */}
      {state === "incomplete" ? (
        <EmptyState>{t("access.checkEmpty")}</EmptyState>
      ) : state === "holderHidden" ? (
        <Banner tone="danger">{t("access.checkHolderHidden")}</Banner>
      ) : state === "checkFailed" ? (
        retryBanner(t("access.checkLoadFailed"), onRetry)
      ) : state === "grantsFailed" ? (
        retryBanner(t("access.checkGrantsFailed"), onRetryGrants)
      ) : state === "assetsForbidden" ? (
        <Banner tone="warning">
          {refusalAskingInstanceAdmin(t("access.checkAssetsForbidden"), t, instanceAdminName)}
        </Banner>
      ) : state === "assetsFailed" ? (
        retryBanner(t("access.checkAssetsFailed"), retryKindAssets)
      ) : check === undefined || state !== "ready" ? (
        <SkeletonList rows={3} />
      ) : (
        <CheckResult
          holderName={holder?.displayLabel ?? t("access.unknownUser")}
          kind={kind}
          assetName={picked === undefined ? assetName : labelOf(picked)}
          check={check}
        />
      )}
    </div>
  );
}

function CheckResult({
  holderName,
  kind,
  assetName,
  check
}: {
  holderName: string;
  kind: string;
  assetName: string;
  check: AssetRightsCheck;
}) {
  const { t, locale } = useTranslation();
  const actions = checkedActions(check);
  const allowed = (verb: CheckedAction["verb"]) =>
    actions.find((action) => action.verb === verb && action.allowed);
  return (
    <Section
      layout="stacked"
      title={t("access.checkResult", { name: holderName, asset: assetName })}
    >
      <div className="grid gap-3">
        {check.holderActive ? null : (
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
                <TableCell>{verbLabel(action.verb, t)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={action.allowed ? "success" : "danger"}>
                      {t(action.allowed ? "access.checkAllowed" : "access.checkRefused")}
                    </Badge>
                    <Badge appearance="outline">{t(reasonLabelKeys[action.reason])}</Badge>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {decidedBy(action, t, check.roles)}
                  {action.onlyInWorkspaces === undefined ? null : (
                    <span className="block text-xs">
                      {onlyInLabel(action.onlyInWorkspaces, t, locale)}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {/* The table answers for the right. What else refuses a save is said under it. */}
        {allowed("write") && (kind === "agent" || kind === "skill") ? (
          <p data-testid="check-right-only" className="text-body text-muted-foreground">
            {t(kind === "agent" ? "access.checkRightOnlyAgent" : "access.checkRightOnlySkill")}
          </p>
        ) : null}
        {allowed("read")?.reason === "grant" && (kind === "agent" || kind === "skill") ? (
          <Banner layout="line">{t("access.checkReadThroughGrant")}</Banner>
        ) : null}
        {actions.some((action) => action.reason === "deny") ? (
          <Banner layout="line">{t("access.checkDenyNote")}</Banner>
        ) : null}
      </div>
    </Section>
  );
}
