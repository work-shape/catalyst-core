import type { HTMLAttributes, ReactNode } from "react";
import { avatarGradient } from "../avatar-gradient";
import { cn } from "../cn";

/** Who or what the avatar stands for. A person is a circle, every thing a rounded square. */
export type AvatarKind = "person" | "workspace" | "agent" | "app";
export type AvatarSize = "xs" | "sm" | "md" | "lg";

/** A fill and the text colour that reads on it, as CSS colour values. */
export interface AvatarAccent {
  background: string;
  foreground: string;
}

const avatarSizes: Record<AvatarSize, string> = {
  xs: "size-5 text-micro [&>svg]:size-3",
  sm: "size-6 text-micro [&>svg]:size-3",
  md: "size-8 text-caption [&>svg]:size-4",
  lg: "size-10 text-body [&>svg]:size-5"
};

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  kind: AvatarKind;
  /** The name the initials are taken from. */
  name: string;
  /** Shown in place of the initials. */
  emoji?: string | null;
  /** Shown in place of the initials and the emoji. */
  icon?: ReactNode;
  /** The object's own colour pair. Without it the avatar is a neutral grey with initials in the text colour. */
  accent?: AvatarAccent;
  size?: AvatarSize;
}

/**
 * The mark of a person or a thing. It stands beside the name it belongs to, so assistive
 * technology skips it unless the caller says otherwise.
 */
export function Avatar({
  kind,
  name,
  emoji,
  icon,
  accent,
  size = "md",
  className,
  style,
  ...props
}: AvatarProps) {
  const trimmedEmoji = emoji?.trim();
  return (
    <span
      aria-hidden="true"
      data-kind={kind}
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden leading-none font-semibold text-foreground select-none",
        kind === "person" ? "rounded-full" : "rounded-md",
        avatarSizes[size],
        className
      )}
      style={{
        ...(accent
          ? { background: accent.background, color: accent.foreground }
          : { background: avatarGradient(name) }),
        ...style
      }}
      {...props}
    >
      {icon ?? (trimmedEmoji ? trimmedEmoji : initials(name))}
    </span>
  );
}

/** The first letters of the first two words, or the first two letters of a single word. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters =
    words.length > 1
      ? words.slice(0, 2).map((word) => Array.from(word)[0] ?? "")
      : Array.from(words[0] ?? "").slice(0, 2);
  return letters.join("").toLocaleUpperCase() || "?";
}
