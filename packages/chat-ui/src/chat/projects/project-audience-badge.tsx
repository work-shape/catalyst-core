import { Lock, Users } from "lucide-react";
import type { ProjectView } from "@work-shape/catalyst-api-client";
import { Badge } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

/** The audience of a project as a badge: shared with the workspace, or the lock of "Only me". */
export function ProjectAudienceBadge({
  project,
  workspace
}: {
  project: Pick<ProjectView, "audience">;
  workspace: string;
}) {
  const { t } = useTranslation();
  return project.audience === "private" ? (
    <Badge size="sm" data-testid="project-audience-private">
      <Lock aria-hidden="true" className="size-3" />
      {t("projects.audiencePrivate")}
    </Badge>
  ) : (
    <Badge
      size="sm"
      appearance="outline"
      className="max-w-full"
      title={t("projects.audienceShared", { workspace })}
      data-testid="project-audience-shared"
    >
      <Users aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{t("projects.audienceShared", { workspace })}</span>
    </Badge>
  );
}
