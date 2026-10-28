import { Share2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DropdownMenuItem } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { AssetShareDialog } from "./asset-share-dialog";
import {
  shareTargetOwner,
  shareTargets,
  shareWorkspaces,
  type AssetShareSource,
  type AssetShareSubject,
  type AssetShareTarget
} from "./asset-share-model";
import type { BuildWorkspace } from "../../shared/build-rights";
import { useKnownWorkspaces, type AssetOwner } from "./asset-place";

/** "Teilen…" of one asset: the item of its head's menu and the dialog it opens. */
export interface AssetShare {
  /** Undefined where the asset cannot go further up, or the reader may not change it. */
  item: ReactNode;
  dialog: ReactNode;
  /** Opens the dialog on `target`, or on the first rung above the asset. */
  open(target?: AssetShareTarget): void;
  /** The rungs above the asset the reader may share it to. */
  targets: readonly AssetShareTarget[];
}

/**
 * "Teilen mit…" (SHARE-1) for a page or a chooser: offered where the source can move assets,
 * the reader may change the asset, and a rung above it is open to them. The instance decides
 * the rest and says it in the dialog.
 */
export function useAssetShare({
  source,
  subject,
  canShare,
  toEveryone = true,
  workspaces,
  onMoved
}: {
  source: AssetShareSource | undefined;
  subject: AssetShareSubject | undefined;
  canShare: boolean;
  /** False for a kind the instance cannot own, such as an App. */
  toEveryone?: boolean;
  /** The workspaces the reader knows, where the page stands outside Studio's. */
  workspaces?: readonly BuildWorkspace[];
  /** The asset moved to `owner`: the page shows its new place. */
  onMoved(owner: AssetOwner): void;
}): AssetShare {
  const { t } = useTranslation();
  const known = useKnownWorkspaces();
  const [opened, setOpened] = useState<{ count: number; target?: AssetShareTarget }>();
  // The reader's own workspaces, asked once the page may share: Studio names a team only where
  // they hold a right on its assets, and without one they may still ask to share into it. A
  // page may build its source anew on every render, so the asking follows the owner alone.
  const [memberships, setMemberships] = useState<readonly BuildWorkspace[]>([]);
  const sourceNow = useRef(source);
  sourceNow.current = source;
  const mayAsk = source?.memberships !== undefined && canShare;
  const owner = subject?.owner.kind === "workspace" ? subject.owner.workspaceId : undefined;
  useEffect(() => {
    const ask = sourceNow.current;
    if (!mayAsk || owner === undefined || !ask?.memberships) return undefined;
    let current = true;
    ask.memberships().then(
      (own) => {
        if (current) setMemberships(own);
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [mayAsk, owner]);
  const targets =
    source && subject && canShare
      ? shareTargets(subject.owner, shareWorkspaces(workspaces ?? known, memberships), {
          toEveryone
        })
      : [];
  const open = (target?: AssetShareTarget) =>
    setOpened((before) => ({ count: (before?.count ?? 0) + 1, ...(target ? { target } : {}) }));
  const offered = source !== undefined && subject !== undefined && targets.length > 0;
  return {
    targets,
    open,
    item: offered ? (
      <DropdownMenuItem icon={<Share2 aria-hidden="true" />} onSelect={() => open()}>
        {t("share.action")}
      </DropdownMenuItem>
    ) : undefined,
    dialog:
      offered && opened !== undefined ? (
        <AssetShareDialog
          // Each opening starts clean: no check or confirmation from the one before.
          key={opened.count}
          open
          subject={subject}
          targets={targets}
          {...(opened.target ? { initialTarget: opened.target } : {})}
          source={source}
          onClose={() => setOpened(undefined)}
          onMoved={(_result, target) => {
            setOpened(undefined);
            onMoved(shareTargetOwner(target));
          }}
        />
      ) : null
  };
}
