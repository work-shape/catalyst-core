import type { ReactNode } from "react";
import type { AdministeredUser } from "@vivd-catalyst/api-client";
import { Avatar, Badge, FormNotice as LibraryFormNotice } from "@vivd-catalyst/ui";
import type { FormNoticeState } from "./user-administration-model";
import { useTranslation } from "../i18n";

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

/** Shows a form's notice state, and nothing while there is none. */
export function FormNotice({ notice }: { notice: FormNoticeState }) {
  if (!notice) {
    return null;
  }
  return <LibraryFormNotice tone={notice.kind}>{notice.text}</LibraryFormNotice>;
}

export function UserAvatar({
  displayLabel,
  size = "md"
}: {
  displayLabel: string;
  size?: "md" | "lg";
}) {
  return <Avatar kind="person" size={size} name={displayLabel} />;
}

export function StatusBadge({ status }: { status: AdministeredUser["status"] }) {
  const { t } = useTranslation();
  if (status === "deleting") {
    return <Badge tone="warning">{t("settings.statusDeleting")}</Badge>;
  }
  return (
    <Badge
      tone={status === "active" ? "success" : "neutral"}
      appearance={status === "active" ? "soft" : "outline"}
    >
      {t(status === "active" ? "settings.statusActive" : "settings.statusDisabled")}
    </Badge>
  );
}
