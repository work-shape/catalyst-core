import type { ReactNode } from "react";
import { Avatar, Badge, FormNotice as LibraryFormNotice } from "@work-shape/catalyst-ui";
import type { FormNoticeState, UserDisplayStatus } from "./user-administration-model";
import { useTranslation } from "../../shared/i18n";

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

/** The status an account reads with, from `userDisplayStatus`. */
export function StatusBadge({ status }: { status: UserDisplayStatus }) {
  const { t } = useTranslation();
  switch (status) {
    case "active":
      return <Badge tone="success">{t("settings.statusActive")}</Badge>;
    case "invited":
      return <Badge tone="info">{t("settings.statusInvited")}</Badge>;
    case "disabled":
      return <Badge appearance="outline">{t("settings.statusDisabled")}</Badge>;
    case "deleting":
      return <Badge tone="warning">{t("settings.statusDeleting")}</Badge>;
  }
}
