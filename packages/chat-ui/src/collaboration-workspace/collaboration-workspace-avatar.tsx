import { avatarGradient } from "../ui/avatar-gradient";
import { cn } from "../ui/cn";
import {
  collaborationWorkspaceAccentAttributes,
  resolveCollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";

const avatarSizes = {
  sm: "size-6 text-[0.625rem] rounded-md",
  md: "size-8 text-xs rounded-md",
  lg: "size-10 text-sm rounded-lg"
} as const;

export type CollaborationWorkspaceAvatarSize = keyof typeof avatarSizes;

export function CollaborationWorkspaceAvatar({
  name,
  emoji,
  accentColor,
  size = "md",
  className
}: {
  name: string;
  emoji: string | null | undefined;
  accentColor: string | null | undefined;
  size?: CollaborationWorkspaceAvatarSize;
  className?: string;
}) {
  const accent = resolveCollaborationWorkspaceAccentColor({ accentColor, name });
  const accentAttributes = collaborationWorkspaceAccentAttributes(accent, {
    background: "var(--collaboration-workspace-accent-surface)",
    color: "var(--collaboration-workspace-accent-on-surface)"
  });

  return (
    <span
      {...accentAttributes}
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden font-semibold leading-none",
        avatarSizes[size],
        className
      )}
      aria-hidden="true"
    >
      {emoji?.trim() ? emoji.trim() : collaborationWorkspaceInitials(name)}
    </span>
  );
}

/** The Personal Workspace has no accent; it borrows the signed-in user's mark. */
export function PersonalCollaborationWorkspaceAvatar({
  label,
  size = "md",
  className
}: {
  label: string;
  size?: CollaborationWorkspaceAvatarSize;
  className?: string;
}) {
  return (
    <span
      style={{ background: avatarGradient(label) }}
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden border border-white/45 font-semibold leading-none text-white shadow-xs",
        avatarSizes[size],
        className
      )}
      aria-hidden="true"
    >
      {collaborationWorkspaceInitials(label)}
    </span>
  );
}

export function collaborationWorkspaceInitials(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean);
  const initials =
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : label.trim().slice(0, 2);
  return initials.toLocaleUpperCase() || "W";
}
