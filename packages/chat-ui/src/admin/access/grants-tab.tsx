// @rights-screen: included in the rights wording guard.
import { Ban, Ellipsis, Undo2 } from "lucide-react";
import { useState } from "react";
import type {
  AdministeredUser,
  ConfigAssetSummary,
  CreatePermissionGrantRequest,
  LocaleCode,
  EffectivePermissions,
  PermissionGrantRow
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  List,
  SkeletonList,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@work-shape/catalyst-ui";
import { GRANT_EFFECTS } from "@work-shape/catalyst-core";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import {
  groupGrants,
  type GrantGroup,
  type GrantKind,
  type GrantWriteResult,
  type LoadFailure
} from "./access-model";
import { wordsOfKind } from "./grant-words";
import { actionLabel, rightVerb, verbKeys, verbOnKind, type RightVerb } from "./right-words";

import { GrantDialog } from "./grant-dialog";
import { grantOptions, type GrantChoices } from "./grant-options";

/**
 * The columns of the grant list once the list itself is wide enough for them. Narrower, a row
 * stacks: the person with the row's menu, then what the person may do there and who granted
 * it. The list's own width decides, not the window's, because the settings rail and the
 * sidebar take their share of a window.
 */
const GRANT_COLUMNS = "@xl:grid-cols-[minmax(0,4fr)_minmax(0,10fr)_1.75rem]";

type Translate = TranslationContextValue["t"];

export type { GrantChoices } from "./grant-options";

/** The names the page was told, by id: of a workspace, and of an asset beyond agents and skills. */
interface ScopeNames {
  workspace(workspaceId: string): string | undefined;
  asset(assetId: string): string | undefined;
}

/**
 * Where a row applies, in one line. An asset is named by the title its kind's list gives it,
 * else by its name; a workspace by the name the page was told. The server leaves an asset's
 * name out for a reader who may not see it, and the row then says that much, never an id.
 */
function scopeLabel(grant: PermissionGrantRow, t: Translate, names: ScopeNames): string {
  switch (grant.scopeKind) {
    case "instance":
      return t("access.scopeWholeInstance");
    case "workspace": {
      const name = grant.scopeId === undefined ? undefined : names.workspace(grant.scopeId);
      return name === undefined
        ? t("access.scopeWorkspaceHidden")
        : t("access.scopeWorkspace", { name });
    }
    case "asset": {
      const asset = grant.scopeAsset;
      const name =
        (grant.scopeId === undefined ? undefined : names.asset(grant.scopeId)) ?? asset?.name;
      if (asset === undefined || name === undefined) {
        return t("access.scopeAssetHidden");
      }
      const words = wordsOfKind(asset.kind);
      return words ? t(words.scopeAsset, { name }) : name;
    }
  }
}

/**
 * What one person's rows on one place say, one sentence per effect: "may view and edit agents
 * in Kai Spezis", "may not delete the agent tax-helper". A right that is no verb of the table,
 * such as adding rows to a Data Store, follows in its own words; where no sentence of its effect
 * names the place, it names the place itself.
 */
function grantSentences(group: GrantGroup, t: Translate, locale: LocaleCode, names: ScopeNames) {
  const { scope } = group;
  return GRANT_EFFECTS.flatMap((effect) => {
    const grants = group.grants.filter((grant) => grant.effect === effect);
    const byKind = new Map<string, RightVerb[]>();
    const ownActions: string[] = [];
    for (const grant of grants) {
      const verb = rightVerb(grant.action);
      const kind = grant.action.slice(0, grant.action.indexOf("."));
      if (verb && wordsOfKind(kind)) {
        byKind.set(kind, [...(byKind.get(kind) ?? []), verb]);
      } else {
        ownActions.push(actionLabel(grant.action, t));
      }
    }
    const verbs = (list: readonly RightVerb[]) => {
      const joined = new Intl.ListFormat(locale, {
        type: effect === "deny" ? "disjunction" : "conjunction"
      }).format(list.map((verb) => t(verbKeys[verb])));
      return effect === "deny" ? t("access.rowNot", { verbs: joined }) : joined;
    };
    const kinds = [...byKind.entries()];
    const sentence =
      kinds.length === 0
        ? undefined
        : scope.scopeKind === "asset"
          ? t("access.rowOnAsset", {
              verbs: verbs(kinds.flatMap(([, list]) => list)),
              object: assetObject(scope, t, names)
            })
          : t("access.rowInPlace", {
              actions: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                kinds.map(([kind, list]) => verbOnKind(kind, verbs(list), t) ?? verbs(list))
              ),
              place: placePhrase(scope, t, names)
            });
    // A deny is marked by its badge, so its words do not say "Denied" again.
    const ownWords = ownActions.map((action) =>
      sentence === undefined
        ? t("access.rowOwnAt", { action, scope: scopeLabel(scope, t, names) })
        : t("access.rowAlso", { action })
    );
    return [
      ...(sentence === undefined ? [] : [{ effect, text: sentence }]),
      ...ownWords.map((text) => ({ effect, text }))
    ];
  });
}

/** Where a row on more than one asset applies, as the end of its sentence. */
function placePhrase(grant: PermissionGrantRow, t: Translate, names: ScopeNames): string {
  switch (grant.scopeKind) {
    case "workspace": {
      const name = grant.scopeId === undefined ? undefined : names.workspace(grant.scopeId);
      return name === undefined ? t("access.placeWorkspaceHidden") : t("access.placeIn", { name });
    }
    case "instance":
      return t("access.placeInstance");
    default:
      // A retired place, named as the rows name it.
      return t("access.placeIn", { name: scopeLabel(grant, t, names) });
  }
}

/** The one asset a row applies to, as what its sentence allows or refuses. */
function assetObject(grant: PermissionGrantRow, t: Translate, names: ScopeNames): string {
  const asset = grant.scopeAsset;
  const name =
    (grant.scopeId === undefined ? undefined : names.asset(grant.scopeId)) ?? asset?.name;
  const words = asset && wordsOfKind(asset.kind);
  return name === undefined || words === undefined
    ? t("access.objectHidden")
    : t(words.object, { name });
}

export interface GrantsTabProps {
  /** The giver's effective rights; absent while loading or after a failed read. */
  giver?: EffectivePermissions;
  /** Absent while the grants load. */
  grants: readonly PermissionGrantRow[] | undefined;
  loadFailed: boolean;
  onRetry(): void;
  /** The users the caller is shown. Absent while they load and when they could not be loaded. */
  users: readonly AdministeredUser[] | undefined;
  usersFailed: boolean;
  /** The active agents and skills. Absent while they load and when they could not be loaded. */
  assets: readonly ConfigAssetSummary[] | undefined;
  /** `forbidden` when the caller may not read the agents and skills of the instance. */
  assetsFailure: LoadFailure | undefined;
  /**
   * The assets of every further kind the instance has, such as its Connections and its
   * Workflows, by kind. A kind without an entry is not offered: the instance has no such kind
   * while its module is off. Agents and skills are always offered.
   */
  kindAssets?: Partial<Record<GrantKind, GrantChoices>>;
  /** The Shared Workspaces, for a grant on what a workspace owns and to name such a row. */
  workspaces?: GrantChoices;
  /** An active instance admin, whom a refusal names as the one who can help. */
  instanceAdminName?: string;
  /**
   * Writes the rows that do not exist yet and says how many it added. Rejects with a
   * `GrantWriteError` that names the refused row and how many were written before it.
   */
  onGrant(requests: readonly CreatePermissionGrantRequest[]): Promise<GrantWriteResult>;
  onRevoke(grantId: string): Promise<unknown>;
}

/** The grants of the instance, one row per person and place, and the dialog that writes them. */
export function GrantsTab({
  giver,
  grants,
  loadFailed,
  onRetry,
  users,
  usersFailed,
  assets,
  assetsFailure,
  kindAssets,
  workspaces,
  instanceAdminName,
  onGrant,
  onRevoke
}: GrantsTabProps) {
  const { t, locale } = useTranslation();
  const [granting, setGranting] = useState(false);
  const [written, setWritten] = useState<GrantWriteResult | undefined>();
  const [pendingRevoke, setPendingRevoke] = useState<PermissionGrantRow | undefined>();
  const [revoking, setRevoking] = useState(false);
  const [revokeFailed, setRevokeFailed] = useState(false);
  const findUser = (userId: string | undefined) =>
    userId === undefined ? undefined : users?.find((user) => user.id === userId);
  const holderName = (holderId: string) =>
    findUser(holderId)?.displayLabel ?? t("access.unknownUser");
  const scopeNames: ScopeNames = {
    workspace: (workspaceId) =>
      workspaces?.items?.find((workspace) => workspace.id === workspaceId)?.name,
    asset: (assetId) =>
      Object.values(kindAssets ?? {})
        .flatMap((choices) => choices.items ?? [])
        .find((asset) => asset.id === assetId)?.name
  };

  const choiceAssets: Partial<Record<GrantKind, GrantChoices>> = {
    ...Object.fromEntries(
      (["agent", "skill"] as const).map((kind) => [
        kind,
        {
          items: assets?.flatMap((asset) =>
            asset.kind === kind && asset.id !== undefined
              ? [
                  {
                    id: asset.id,
                    name: asset.name,
                    resource: { kind, name: asset.name, assetId: asset.id }
                  }
                ]
              : []
          ),
          failed: assetsFailure !== undefined
        }
      ])
    ),
    ...kindAssets
  };
  const options = grantOptions(giver, choiceAssets, workspaces);
  const newGrant = (
    <Button size="sm" disabled={options.kinds.length === 0} onClick={() => setGranting(true)}>
      {t("access.newGrant")}
    </Button>
  );

  return (
    <div className="grid gap-4">
      {revokeFailed ? (
        <Banner tone="danger" onDismiss={() => setRevokeFailed(false)}>
          {t("access.revokeFailed")}
        </Banner>
      ) : null}
      {/* Rows that existed already were left alone: the person is told what was added. */}
      {written !== undefined && written.existing > 0 ? (
        <Banner onDismiss={() => setWritten(undefined)}>
          {t(written.added === 0 ? "access.grantNothingAdded" : "access.grantPartlyAdded", {
            added: written.added,
            existing: written.existing
          })}
        </Banner>
      ) : null}
      {loadFailed ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("tryAgain")}
            </Button>
          }
        >
          {t("access.grantsLoadFailed")}
        </Banner>
      ) : grants === undefined ? (
        <SkeletonList rows={4} />
      ) : grants.length === 0 ? (
        <EmptyState action={newGrant}>{t("access.grantsEmpty")}</EmptyState>
      ) : (
        <>
          <div className="flex justify-end">{newGrant}</div>
          <div className="@container">
            <div
              aria-hidden="true"
              className={`hidden gap-x-4 border-b px-3 pb-2 text-caption font-medium text-muted-foreground @xl:grid ${GRANT_COLUMNS}`}
            >
              <span>{t("access.grantHolder")}</span>
              <span>{t("access.grantRight")}</span>
            </div>
            <List className="gap-0">
              {groupGrants(grants, holderName).map((group) => (
                <GrantGroupRow
                  key={group.key}
                  group={group}
                  holder={findUser(group.holderId)}
                  holderName={holderName(group.holderId)}
                  grantedBy={grantedByText(group, findUser, t)}
                  grantedAt={formatDate(latest(group), locale)}
                  sentences={grantSentences(group, t, locale, scopeNames)}
                  onRevoke={setPendingRevoke}
                />
              ))}
            </List>
          </div>
        </>
      )}
      {granting ? (
        <GrantDialog
          users={users}
          usersFailed={usersFailed}
          assets={assets}
          assetsFailure={assetsFailure}
          kindAssets={choiceAssets}
          options={options}
          workspaces={workspaces}
          instanceAdminName={instanceAdminName}
          onGrant={(requests) =>
            onGrant(requests).then((result) => {
              setWritten(result);
              return result;
            })
          }
          onClose={() => setGranting(false)}
        />
      ) : null}
      {pendingRevoke ? (
        <ConfirmDialog
          open
          title={t(
            pendingRevoke.effect === "deny" ? "access.revokeDenyTitle" : "access.revokeTitle"
          )}
          confirmLabel={t(pendingRevoke.effect === "deny" ? "access.revokeDeny" : "access.revoke")}
          loading={revoking}
          onConfirm={() => {
            setRevoking(true);
            setRevokeFailed(false);
            onRevoke(pendingRevoke.id)
              .catch(() => setRevokeFailed(true))
              .finally(() => {
                setRevoking(false);
                setPendingRevoke(undefined);
              });
          }}
          onClose={() => setPendingRevoke(undefined)}
        >
          {t(
            pendingRevoke.effect === "deny"
              ? "access.revokeDenyDescription"
              : "access.revokeAllowDescription",
            {
              name: holderName(pendingRevoke.holderId),
              action: actionLabel(pendingRevoke.action, t),
              scope: scopeLabel(pendingRevoke, t, scopeNames)
            }
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** The newest row of a group: when the person last got something there. */
function latest(group: GrantGroup): string {
  return group.grants.reduce(
    (newest, grant) => (grant.createdAt > newest ? grant.createdAt : newest),
    group.scope.createdAt
  );
}

/**
 * Who wrote the rows of a group. The server leaves out a writer the reader is not shown: that
 * is no error, and the cell says so in words instead of staying empty.
 */
function grantedByText(
  group: GrantGroup,
  findUser: (userId: string | undefined) => AdministeredUser | undefined,
  t: Translate
): string {
  const names = group.grants.map(
    (grant) => findUser(grant.grantedBy)?.displayLabel ?? t("access.notAvailable")
  );
  return [...new Set(names)].join(", ");
}

/** One person's rows on one place: the actions as chips, each revoked from the row's menu. */
function GrantGroupRow({
  group,
  holder,
  holderName,
  grantedBy,
  grantedAt,
  sentences,
  onRevoke
}: {
  group: GrantGroup;
  holder: AdministeredUser | undefined;
  holderName: string;
  grantedBy: string;
  grantedAt: string;
  /** What the rows allow and refuse there, one sentence per effect. */
  sentences: readonly { effect: PermissionGrantRow["effect"]; text: string }[];
  onRevoke(grant: PermissionGrantRow): void;
}) {
  const { t } = useTranslation();
  const assetGone = group.scope.scopeAsset?.active === false;
  return (
    <li
      data-testid="grant-row"
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 border-b px-3 py-3 last:border-0 ${GRANT_COLUMNS}`}
    >
      <div className="grid min-w-0">
        <span className="truncate">{holderName}</span>
        {holder?.email ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A long address is cut; the whole of it shows on hover and on focus. */}
              <span
                tabIndex={0}
                className="truncate rounded-sm text-caption text-muted-foreground focus-visible:focus-ring"
              >
                {holder.email}
              </span>
            </TooltipTrigger>
            <TooltipContent>{holder.email}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="@xl:order-last">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" label={t("access.grantMenu", { name: holderName })}>
              <Ellipsis aria-hidden="true" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {group.grants.map((grant) => (
              <DropdownMenuItem
                key={grant.id}
                tone="danger"
                icon={<Undo2 aria-hidden="true" />}
                onSelect={() => onRevoke(grant)}
              >
                {t(grant.effect === "deny" ? "access.revokeDenyItem" : "access.revokeAllowItem", {
                  action: actionLabel(grant.action, t)
                })}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="col-span-2 grid min-w-0 justify-items-start gap-1.5 @xl:col-span-1">
        <ul className="grid min-w-0 gap-1">
          {sentences.map((sentence) => (
            <li
              key={sentence.text}
              data-effect={sentence.effect}
              className="flex min-w-0 items-start gap-1.5 break-words"
            >
              {/* A deny differs by its word and its badge, not by colour alone. */}
              {sentence.effect === "deny" ? (
                <Badge tone="danger" appearance="outline" size="sm">
                  <Ban aria-hidden="true" />
                  {t("access.rowDenied")}
                </Badge>
              ) : null}
              <span className="min-w-0">{sentence.text}</span>
            </li>
          ))}
        </ul>
        {assetGone ? (
          <>
            <Badge tone="warning" size="sm">
              {t("access.scopeAssetGone")}
            </Badge>
            <span className="text-caption text-muted-foreground">
              {t("access.scopeAssetGoneHint")}
            </span>
          </>
        ) : null}
        <span className="text-caption text-muted-foreground">
          {t("access.grantedByLine", { name: grantedBy, date: grantedAt })}
        </span>
      </div>
    </li>
  );
}

function formatDate(value: string, locale: LocaleCode): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
