import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import type { AdministeredUser } from "@vivd-catalyst/api-client";
import { avatarGradient } from "./avatar-gradient";
import type { FormNoticeState } from "./user-administration-model";
import { Badge } from "./ui/badge";
import { cn } from "./ui/cn";

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid content-start gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

export function FormNotice({ notice }: { notice: FormNoticeState }) {
  if (!notice) {
    return null;
  }
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-1.5 text-sm",
        notice.kind === "error" ? "text-destructive" : "text-emerald-700"
      )}
    >
      {notice.kind === "error" ? (
        <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      ) : (
        <CheckCircle2 size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      )}
      <span>{notice.text}</span>
    </p>
  );
}

export function UserAvatar({
  displayLabel,
  size = "md"
}: {
  displayLabel: string;
  size?: "md" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      style={{ background: avatarGradient(displayLabel) }}
      className={cn(
        "grid shrink-0 place-items-center font-semibold text-white shadow-sm ring-1 ring-white/45",
        size === "lg" ? "size-11 rounded-[11px] text-sm" : "size-8 rounded-[9px] text-xs"
      )}
    >
      {initials(displayLabel)}
    </span>
  );
}

export function StatusBadge({ status }: { status: AdministeredUser["status"] }) {
  return (
    <Badge variant={status === "active" ? "success" : "outline"} className="capitalize">
      {status}
    </Badge>
  );
}

function initials(displayLabel: string): string {
  const parts = displayLabel.trim().split(/\s+/u).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}
