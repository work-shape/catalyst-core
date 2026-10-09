import { Avatar, type AvatarSize } from "@vivd-catalyst/ui";
import {
  collaborationWorkspaceAccentAttributes,
  resolveCollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";

export type CollaborationWorkspaceAvatarSize = Extract<AvatarSize, "sm" | "md" | "lg">;

// The pair `styles.css` resolves for the active mode from the attributes on the same element.
const workspaceAccent = {
  background: "var(--collaboration-workspace-accent-surface)",
  foreground: "var(--collaboration-workspace-accent-on-surface)"
};

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

  return (
    <Avatar
      {...collaborationWorkspaceAccentAttributes(accent)}
      kind="workspace"
      name={name}
      emoji={emoji}
      accent={workspaceAccent}
      size={size}
      className={className}
    />
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
  return <Avatar kind="person" name={label} size={size} className={className} />;
}

/** The initials a hand-drawn member mark shows; the avatars above take theirs from the library. */
export function collaborationWorkspaceInitials(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean);
  const initials =
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : label.trim().slice(0, 2);
  return initials.toLocaleUpperCase() || "W";
}
