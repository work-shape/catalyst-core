import { ChevronsUpDown, Compass, Plus, Settings } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import { useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { useScrollEdgeFade } from "../ui/scroll-edge-fade";
import {
  collaborationWorkspaceAccentAttributes,
  resolveCollaborationWorkspaceAccentColor,
  type CollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";
import {
  CollaborationWorkspaceAvatar,
  PersonalCollaborationWorkspaceAvatar
} from "./collaboration-workspace-avatar";

export function CollaborationWorkspaceSelector({
  collaborationWorkspaces,
  activeCollaborationWorkspaceId,
  userLabel,
  loading,
  loadFailed,
  clientBrandingHeader,
  onSelectCollaborationWorkspace,
  onOpenCollaborationWorkspaceSettings,
  onBrowseCollaborationWorkspaces,
  onCreateCollaborationWorkspace
}: {
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  userLabel: string;
  loading: boolean;
  loadFailed: boolean;
  /** Client identity, shown at the top of the popover once the rail's own branding row is gone. */
  clientBrandingHeader?: ReactNode;
  onSelectCollaborationWorkspace(collaborationWorkspaceId: string): void;
  onOpenCollaborationWorkspaceSettings(collaborationWorkspaceId: string): void;
  onBrowseCollaborationWorkspaces(): void;
  onCreateCollaborationWorkspace(): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeCollaborationWorkspace = collaborationWorkspaces.find(
    (collaborationWorkspace) => collaborationWorkspace.id === activeCollaborationWorkspaceId
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function selectCollaborationWorkspace(collaborationWorkspaceId: string) {
    setOpen(false);
    onSelectCollaborationWorkspace(collaborationWorkspaceId);
  }

  function openCollaborationWorkspaceSettings(collaborationWorkspaceId: string) {
    setOpen(false);
    onOpenCollaborationWorkspaceSettings(collaborationWorkspaceId);
  }

  const triggerLabel = activeCollaborationWorkspace
    ? collaborationWorkspaceDisplayName(activeCollaborationWorkspace, t)
    : loading
      ? t("collaborationWorkspaceLoading")
      : t("collaborationWorkspacePersonalName");

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid="collaboration-workspace-selector-trigger"
        className={cn(
          "grid h-11 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-left outline-none transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/40",
          open && "bg-sidebar-accent text-sidebar-accent-foreground"
        )}
        aria-label={t("collaborationWorkspaceSelectorLabel")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        {activeCollaborationWorkspace?.kind === "shared" ? (
          <CollaborationWorkspaceAvatar
            name={activeCollaborationWorkspace.name}
            emoji={activeCollaborationWorkspace.emoji}
            accentColor={activeCollaborationWorkspace.accentColor}
          />
        ) : (
          <PersonalCollaborationWorkspaceAvatar label={userLabel} />
        )}
        <span className="truncate text-sm font-medium">{triggerLabel}</span>
        <ChevronsUpDown size={15} className="text-muted-foreground" aria-hidden="true" />
      </button>

      {open ? (
        <CollaborationWorkspaceSelectorMenu
          collaborationWorkspaces={collaborationWorkspaces}
          activeCollaborationWorkspaceId={activeCollaborationWorkspaceId}
          userLabel={userLabel}
          loading={loading}
          loadFailed={loadFailed}
          clientBrandingHeader={clientBrandingHeader}
          onSelectCollaborationWorkspace={selectCollaborationWorkspace}
          onOpenCollaborationWorkspaceSettings={openCollaborationWorkspaceSettings}
          onBrowseCollaborationWorkspaces={() => {
            setOpen(false);
            onBrowseCollaborationWorkspaces();
          }}
          onCreateCollaborationWorkspace={() => {
            setOpen(false);
            onCreateCollaborationWorkspace();
          }}
        />
      ) : null}
    </div>
  );
}

export function CollaborationWorkspaceSelectorMenu({
  collaborationWorkspaces,
  activeCollaborationWorkspaceId,
  userLabel,
  loading,
  loadFailed,
  clientBrandingHeader,
  onSelectCollaborationWorkspace,
  onOpenCollaborationWorkspaceSettings,
  onBrowseCollaborationWorkspaces,
  onCreateCollaborationWorkspace
}: {
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  userLabel: string;
  loading: boolean;
  loadFailed: boolean;
  clientBrandingHeader?: ReactNode;
  onSelectCollaborationWorkspace(collaborationWorkspaceId: string): void;
  onOpenCollaborationWorkspaceSettings(collaborationWorkspaceId: string): void;
  onBrowseCollaborationWorkspaces(): void;
  onCreateCollaborationWorkspace(): void;
}) {
  const { t } = useTranslation();
  const personalCollaborationWorkspace = collaborationWorkspaces.find(
    (collaborationWorkspace) => collaborationWorkspace.kind === "personal"
  );
  const sharedCollaborationWorkspaces = collaborationWorkspaces
    .filter((collaborationWorkspace) => collaborationWorkspace.kind === "shared")
    .sort((left, right) => left.name.localeCompare(right.name));
  const fade = useScrollEdgeFade<HTMLDivElement>([collaborationWorkspaces.length]);

  return (
    <div
      role="dialog"
      aria-label={t("collaborationWorkspaceSelectorLabel")}
      className="absolute left-0 top-[calc(100%+0.5rem)] z-50 grid w-[min(19rem,calc(100vw-3rem))] gap-1 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg"
    >
      {clientBrandingHeader}
      {loadFailed ? (
        <p className="px-2 py-3 text-sm text-destructive">
          {t("collaborationWorkspaceLoadFailed")}
        </p>
      ) : loading && collaborationWorkspaces.length === 0 ? (
        <p className="px-2 py-3 text-sm text-muted-foreground">
          {t("collaborationWorkspaceLoading")}
        </p>
      ) : (
        <>
          {/*
            A long workspace list scrolls here instead of running off the
            viewport, and the create/browse footer below stays reachable. The
            negative margin plus padding leaves room for the row focus rings,
            which the scroll container would otherwise clip, and the edge fade
            shows when more workspaces are hidden past the cut.
          */}
          <div
            ref={fade.ref}
            style={fade.style}
            className="chat-scrollbar -mx-1 grid max-h-[min(22rem,50vh)] auto-rows-max gap-1 overflow-y-auto px-1"
            onScroll={fade.onScroll}
          >
            {personalCollaborationWorkspace ? (
              <CollaborationWorkspaceRow
                active={personalCollaborationWorkspace.id === activeCollaborationWorkspaceId}
                avatar={<PersonalCollaborationWorkspaceAvatar label={userLabel} />}
                name={t("collaborationWorkspacePersonalName")}
                onSelect={() => onSelectCollaborationWorkspace(personalCollaborationWorkspace.id)}
              />
            ) : null}

            {sharedCollaborationWorkspaces.length > 0 ? (
              <>
                <p className="px-2 pb-1 pt-3 text-xs text-muted-foreground">
                  {t("collaborationWorkspaceSharedHeading")}
                </p>
                {sharedCollaborationWorkspaces.map((collaborationWorkspace) => (
                  <CollaborationWorkspaceRow
                    key={collaborationWorkspace.id}
                    accentColor={resolveCollaborationWorkspaceAccentColor(collaborationWorkspace)}
                    active={collaborationWorkspace.id === activeCollaborationWorkspaceId}
                    avatar={
                      <CollaborationWorkspaceAvatar
                        name={collaborationWorkspace.name}
                        emoji={collaborationWorkspace.emoji}
                        accentColor={collaborationWorkspace.accentColor}
                      />
                    }
                    name={collaborationWorkspace.name}
                    pendingAccessRequestCount={collaborationWorkspace.pendingAccessRequestCount}
                    onSelect={() => onSelectCollaborationWorkspace(collaborationWorkspace.id)}
                    onOpenSettings={
                      canManageCollaborationWorkspace(collaborationWorkspace)
                        ? () => onOpenCollaborationWorkspaceSettings(collaborationWorkspace.id)
                        : undefined
                    }
                  />
                ))}
              </>
            ) : null}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-1 border-t pt-2">
            <Button
              type="button"
              variant="ghost"
              className="h-9 w-full text-muted-foreground"
              aria-label={t("collaborationWorkspaceCreate")}
              onClick={onCreateCollaborationWorkspace}
            >
              <Plus size={16} aria-hidden="true" />
              <span>{t("collaborationWorkspaceCreateShort")}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-9 w-full text-muted-foreground"
              aria-label={t("collaborationWorkspaceBrowse")}
              onClick={onBrowseCollaborationWorkspaces}
            >
              <Compass size={16} aria-hidden="true" />
              <span>{t("collaborationWorkspaceBrowseShort")}</span>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CollaborationWorkspaceRow({
  accentColor,
  active,
  avatar,
  name,
  pendingAccessRequestCount = 0,
  onSelect,
  onOpenSettings
}: {
  accentColor?: CollaborationWorkspaceAccentColor;
  active: boolean;
  avatar: ReactNode;
  name: string;
  pendingAccessRequestCount?: number;
  onSelect(): void;
  onOpenSettings?(): void;
}) {
  const { t } = useTranslation();
  const accentAttributes =
    accentColor && active
      ? collaborationWorkspaceAccentAttributes(accentColor, {
          background:
            "color-mix(in srgb, var(--collaboration-workspace-accent-surface) 16%, transparent)"
        })
      : undefined;

  return (
    <div
      {...accentAttributes}
      data-testid="collaboration-workspace-row"
      data-active={active ? "true" : undefined}
      className={cn(
        "group/collaboration-workspace-row grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center rounded-md transition-colors",
        "hover:bg-accent/60",
        active && !accentAttributes && "bg-accent/70"
      )}
    >
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        onClick={onSelect}
      >
        {avatar}
        <span className="truncate text-sm font-medium">{name}</span>
      </button>
      {onOpenSettings ? (
        <button
          type="button"
          className={cn(
            "relative mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
            "hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40",
            pendingAccessRequestCount > 0
              ? "opacity-100"
              : "opacity-100 md:opacity-0 md:group-hover/collaboration-workspace-row:opacity-100 md:group-focus-within/collaboration-workspace-row:opacity-100"
          )}
          aria-label={t("collaborationWorkspaceOpenSettings", { name })}
          title={t("collaborationWorkspaceOpenSettings", { name })}
          onClick={onOpenSettings}
        >
          <Settings size={15} aria-hidden="true" />
          {pendingAccessRequestCount > 0 ? (
            <span
              data-testid="collaboration-workspace-pending-badge"
              className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold leading-4 text-primary-foreground"
              aria-label={t("collaborationWorkspacePendingRequestCount", {
                count: pendingAccessRequestCount
              })}
            >
              {pendingAccessRequestCount}
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}

export function canManageCollaborationWorkspace(
  collaborationWorkspace: Pick<CollaborationWorkspaceWithRole, "kind" | "role">
): boolean {
  return (
    collaborationWorkspace.kind === "shared" &&
    (collaborationWorkspace.role === "owner" || collaborationWorkspace.role === "admin")
  );
}

export function collaborationWorkspaceDisplayName(
  collaborationWorkspace: Pick<CollaborationWorkspaceWithRole, "kind" | "name">,
  translate: (key: "collaborationWorkspacePersonalName") => string
): string {
  return collaborationWorkspace.kind === "personal"
    ? translate("collaborationWorkspacePersonalName")
    : collaborationWorkspace.name;
}
