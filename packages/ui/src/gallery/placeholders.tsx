import type { ReactNode } from "react";
import { cn } from "../cn";

/*
 * Stand-ins for two components of G-5b that the samples of G-5c compose. They exist only so
 * the compositions can be judged before both tickets are merged; each use is replaced by the
 * library's component when they are joined, and this file is deleted.
 */

/** PLACEHOLDER for `Avatar`: its shape follows its kind, a person round, a thing a rounded square. */
export function AvatarPlaceholder({
  kind,
  children
}: {
  kind: "person" | "thing";
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      data-gallery-placeholder="Avatar"
      data-kind={kind}
      className={cn(
        "grid size-6 shrink-0 place-items-center bg-state-pressed text-micro text-foreground",
        kind === "person" ? "rounded-full" : "rounded-md"
      )}
    >
      {children}
    </span>
  );
}

/** PLACEHOLDER for `EmptyState`: an icon, one sentence and one action, with no frame. */
export function EmptyStatePlaceholder({
  icon,
  sentence,
  action
}: {
  icon: ReactNode;
  sentence: string;
  action?: ReactNode;
}) {
  return (
    <div
      data-gallery-placeholder="EmptyState"
      className="grid justify-items-center gap-3 px-4 py-10 text-center [&>svg]:size-5 [&>svg]:text-muted-foreground"
    >
      {icon}
      <p className="text-body text-muted-foreground">{sentence}</p>
      {action}
    </div>
  );
}
