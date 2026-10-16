// @rights-screen: included in the rights wording guard.
import type {
  AdministeredUser,
  ConfigAssetSummary,
  EffectivePermissions,
  NamespaceWithUsage,
  PermissionGrantRow
} from "@work-shape/catalyst-api-client";
import { ASSET_OWNER_KINDS } from "@work-shape/catalyst-core";
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
} from "@work-shape/catalyst-ui";
import { useState } from "react";
import { DocsReference } from "../../shared/docs-links";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import { modelDisplayLabel } from "../../shared/model-label";
import {
  assetNameValid,
  checkAsset,
  checkedAssetId,
  checkState,
  namespaceOfName,
  type CheckableAsset,
  type CheckedAction,
  type CheckedKind,
  type LoadFailure
} from "./access-model";
import { assetKindLabelKey } from "./grant-words";
import { verbLabel } from "./right-words";

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
  /** The Namespaces, for the lists that bind a save. Absent while they load or failed. */
  namespaces: readonly NamespaceWithUsage[] | undefined;
  /** The models of the instance, for the names of the ones a Namespace lists. */
  modelBindings: readonly { id: string; model: string; label?: string }[] | undefined;
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
  const kinds = reportedKinds ?? BUILT_IN_KINDS;
  const [kindId, setKindId] = useState("agent");
  const [name, setName] = useState("");
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
  const retryKindAssets = fromOverview ? onRetryAssets : (otherAssets?.retry ?? onRetryAssets);
  const nameValid = assetNameValid(kind, assetName);
  const state = checkState({
    holderId,
    kind: checkedKind?.kind,
    name: assetName,
    effectiveLoaded: effective !== undefined,
    effectiveFailure,
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
                setName("");
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
          error={
            assetName === "" || nameValid
              ? undefined
              : t(
                  kind === "skill"
                    ? "access.checkNameInvalidSkill"
                    : kind === "agent"
                      ? "access.checkNameInvalidAgent"
                      : "access.checkNameInvalid"
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
        retryBanner(t("access.checkAssetsFailed"), retryKindAssets)
      ) : effective === undefined ||
        holderGrants === undefined ||
        loadedAssets === undefined ||
        checkedKind === undefined ? (
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
            checkedAssetId({ kind, name: assetName }, loadedAssets, holderGrants),
            checkedKind.actions
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
  kind: string,
  namespace: NamespaceWithUsage | undefined,
  modelBindings: readonly { id: string; model: string; label?: string }[] | undefined,
  t: Translate
): string[] {
  const tools = namespace?.allowedToolNames;
  const models = namespace?.allowedModelBindingIds;
  if (kind !== "agent" || !namespace || (!tools && !models)) {
    return [];
  }
  const modelName = (id: string) => {
    const binding = modelBindings?.find((candidate) => candidate.id === id);
    return binding ? modelDisplayLabel(binding) : id;
  };
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
  kind: string;
  assetName: string;
  effective: EffectivePermissions;
  namespace: NamespaceWithUsage | undefined;
  modelBindings: readonly { id: string; model: string; label?: string }[] | undefined;
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
                <TableCell>{verbLabel(action.verb, t)}</TableCell>
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
        {allowed("write") && (kind === "agent" || kind === "skill") ? (
          <p data-testid="check-right-only" className="text-body text-muted-foreground">
            {t(kind === "agent" ? "access.checkRightOnlyAgent" : "access.checkRightOnlySkill")}
          </p>
        ) : null}
        {limits.length > 0 ? (
          <Banner tone="warning" data-testid="check-namespace-limits">
            {limits.join(" ")}
          </Banner>
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
