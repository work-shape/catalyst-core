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
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import {
  groupGrants,
  type GrantGroup,
  type GrantKind,
  type GrantWriteResult,
  type LoadFailure
} from "./access-model";
import { grantSentences, scopeLabel, type ScopeNames } from "./grant-sentences";
import { actionLabel } from "./right-words";

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
                  sentences={grantSentences(group.scope, group.grants, t, locale, scopeNames)}
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
