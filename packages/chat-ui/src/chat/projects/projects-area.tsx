import { Folder, Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type {
  CollaborationWorkspaceWithRole,
  ProjectAudienceView,
  ProjectListItemView,
  ProjectView
} from "@work-shape/catalyst-api-client";
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardTarget,
  CardTitle,
  Dialog,
  EmptyState,
  Field,
  FormNotice,
  InlineError,
  Input,
  Page,
  PageHeader,
  RadioGroup,
  ScopeChip,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  SkeletonList,
  Textarea
} from "@work-shape/catalyst-ui";
import {
  useCreateProjectMutation,
  useMyProjectsQuery,
  useProjectsQuery
} from "../../shared/api/projects";
import { AreaFrame, useAreaTitleFocus } from "../../shared/area-frame";
import { useTranslation } from "../../shared/i18n";
import { formatDateTime } from "../../shared/locale-format";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { RouteLink } from "../../studio/route-link";
import { ProjectAudienceBadge } from "./project-audience-badge";

/** The workspace the projects belong to, as the pages name it. */
interface ProjectsWorkspace {
  id: string;
  /** Its name as the interface shows it; a Personal Workspace's is its owner's. */
  name: string;
  kind: CollaborationWorkspaceWithRole["kind"];
  emoji: string | null;
  defaultConversationVisibility: ProjectAudienceView;
}

/** The workspace a new project is made in. */
type NewProjectWorkspace = Omit<ProjectsWorkspace, "emoji">;

/** A workspace of the person, as the page across workspaces names it (PRJ-5). */
interface ProjectsWorkspaceChoice {
  id: string;
  /** Its name as the interface shows it; a Personal Workspace's is its owner's. */
  name: string;
  kind: CollaborationWorkspaceWithRole["kind"];
  emoji: string | null;
}

interface ProjectsAreaProps {
  route: Extract<WorkspaceRoute, { kind: "projects" }>;
  workspace: ProjectsWorkspace;
  /** Every workspace of the person, in the selector's order. */
  workspaces: readonly ProjectsWorkspaceChoice[];
  onOpenRoute(route: WorkspaceRoute): void;
}

/**
 * The Projects area (PRJ-1): the projects of the open workspace or of all the person's
 * workspaces (PRJ-5). A project's own page is the start of a chat in it (`ProjectChatStart`).
 */
export function ProjectsArea(props: ProjectsAreaProps) {
  return <ProjectsPage key={props.workspace.id} {...props} />;
}

/** Which projects the Projects page lists: the open workspace's, or those of all of them. */
type ProjectsScope = "workspace" | "all";

const PROJECTS_SCOPE_STORAGE_KEY = "vivd-catalyst:projects-scope";

function readProjectsScope(): ProjectsScope {
  try {
    return window.localStorage.getItem(PROJECTS_SCOPE_STORAGE_KEY) === "all" ? "all" : "workspace";
  } catch {
    return "workspace";
  }
}

/** The scope the person chose last, kept in this browser: back from a project it stays. */
function useProjectsScope(): [ProjectsScope, (scope: ProjectsScope) => void] {
  const [scope, setScope] = useState(readProjectsScope);
  return [
    scope,
    (next) => {
      setScope(next);
      try {
        window.localStorage.setItem(PROJECTS_SCOPE_STORAGE_KEY, next);
      } catch {
        // The choice is a convenience: without the store the page opens on this workspace.
      }
    }
  ];
}

/**
 * The projects of all the person's workspaces, one group per workspace: the open one first,
 * then the others in the order the workspace selector lists them. A project of a workspace the
 * person has left since is not shown.
 */
function projectsByWorkspace(
  projects: readonly ProjectListItemView[],
  workspaces: readonly ProjectsWorkspaceChoice[],
  openWorkspaceId: string
): { workspace: ProjectsWorkspaceChoice; projects: ProjectListItemView[] }[] {
  const ordered = [
    ...workspaces.filter((workspace) => workspace.id === openWorkspaceId),
    ...workspaces.filter((workspace) => workspace.id !== openWorkspaceId)
  ];
  return ordered.flatMap((workspace) => {
    const own = projects.filter((project) => project.collaborationWorkspaceId === workspace.id);
    return own.length > 0 ? [{ workspace, projects: own }] : [];
  });
}

function ProjectsPage({ workspace, workspaces, onOpenRoute }: ProjectsAreaProps) {
  const { t } = useTranslation();
  const areaRef = useAreaTitleFocus(true);
  const [scope, setScope] = useProjectsScope();
  const thisWorkspace = useProjectsQuery(workspace.id);
  const all = useMyProjectsQuery(scope === "all");
  const list = scope === "all" ? all : thisWorkspace;
  const [creating, setCreating] = useState(false);
  const groups =
    scope === "all" && list.data
      ? projectsByWorkspace(list.data, workspaces, workspace.id)
      : [{ workspace, projects: list.data ?? [] }];
  const shown = groups.reduce((sum, group) => sum + group.projects.length, 0);

  return (
    <AreaFrame ref={areaRef} label={t("projects.title")}>
      <Page>
        <PageHeader
          title={t("projects.title")}
          description={
            scope === "all"
              ? t("projects.descriptionAll")
              : t("projects.description", { workspace: workspace.name })
          }
          primaryAction={
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("projects.new")}
            </Button>
          }
        />
        {workspaces.length > 1 ? (
          <SegmentedControl
            label={t("projects.scope")}
            // The small size keeps both choices on a phone's width.
            size="sm"
            value={scope}
            onValueChange={(value) => setScope(value === "all" ? "all" : "workspace")}
            className="mb-6"
            data-testid="projects-scope"
          >
            <SegmentedControlItem value="workspace">
              {t("projects.scopeWorkspace")}
            </SegmentedControlItem>
            <SegmentedControlItem value="all">{t("projects.scopeAll")}</SegmentedControlItem>
          </SegmentedControl>
        ) : null}
        {list.isPending ? (
          <SkeletonList rows={3} />
        ) : list.isError ? (
          <InlineError className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("projects.listFailed")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                list.refetch().catch(() => undefined);
              }}
            >
              {t("tryAgain")}
            </Button>
          </InlineError>
        ) : shown === 0 ? (
          <EmptyState icon={<Folder aria-hidden="true" />}>
            {t(scope === "all" ? "projects.emptyAll" : "projects.empty")}
          </EmptyState>
        ) : scope === "all" ? (
          groups.map((group) => (
            <Section
              key={group.workspace.id}
              layout="stacked"
              title={group.workspace.name}
              count={group.projects.length}
              data-testid="projects-workspace-group"
            >
              <ProjectCards
                projects={group.projects}
                workspace={group.workspace}
                showWorkspace
                onOpenRoute={onOpenRoute}
              />
            </Section>
          ))
        ) : (
          <ProjectCards
            projects={groups[0]?.projects ?? []}
            workspace={workspace}
            onOpenRoute={onOpenRoute}
          />
        )}
      </Page>
      <NewProjectDialog
        open={creating}
        workspace={workspace}
        onClose={() => setCreating(false)}
        onCreated={(project) => {
          setCreating(false);
          onOpenRoute({
            kind: "project",
            collaborationWorkspaceId: project.collaborationWorkspaceId,
            project: project.name
          });
        }}
      />
    </AreaFrame>
  );
}

/**
 * The projects of one workspace as cards. Across workspaces each card carries its workspace's
 * chip, and opening one of another workspace switches to it, as a conversation link does.
 */
function ProjectCards({
  projects,
  workspace,
  showWorkspace = false,
  onOpenRoute
}: {
  projects: readonly ProjectListItemView[];
  workspace: Pick<ProjectsWorkspaceChoice, "name" | "kind" | "emoji">;
  showWorkspace?: boolean;
  onOpenRoute(route: WorkspaceRoute): void;
}) {
  const { t, locale } = useTranslation();
  return (
    <ul aria-label={t("projects.title")} className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
      {projects.map((project) => {
        const route: WorkspaceRoute = {
          kind: "project",
          collaborationWorkspaceId: project.collaborationWorkspaceId,
          project: project.name
        };
        return (
          <li key={project.id} className="flex min-w-0" data-testid="project-card">
            <Card padding="md" className="flex w-full min-w-0 flex-col">
              <CardHeader>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Folder aria-hidden="true" className="size-4 text-muted-foreground" />
                  <CardTitle clamp className="min-w-0">
                    {project.title}
                  </CardTitle>
                  <ProjectAudienceBadge project={project} workspace={workspace.name} />
                </div>
                {project.description ? (
                  <p className="line-clamp-2 text-body text-muted-foreground">
                    {project.description}
                  </p>
                ) : null}
              </CardHeader>
              <CardFooter className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-muted-foreground">
                  {showWorkspace ? (
                    <ScopeChip
                      scope={workspace.kind === "personal" ? "personal" : "workspace"}
                      size="sm"
                      name={workspace.name}
                      emoji={workspace.emoji}
                    />
                  ) : null}
                  <span>
                    {[
                      project.conversationCount === 1
                        ? t("projects.chatCountOne")
                        : t("projects.chatCount", { count: project.conversationCount }),
                      t("projects.updatedAt", {
                        date: formatDateTime(project.lastActivityAt, locale)
                      })
                    ].join(" · ")}
                  </span>
                </div>
                <CardTarget
                  label={t("projects.open", { title: project.title })}
                  title={project.title}
                >
                  <RouteLink route={route} variant="outline" onOpen={onOpenRoute}>
                    {t("projects.openAction")}
                  </RouteLink>
                </CardTarget>
              </CardFooter>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Makes a project in the open workspace: its name, a description and who sees it. The choice
 * starts at the workspace's default for conversations; a Personal Workspace has none. The
 * Projects page and the plus of the rail's Projects group open it.
 */
export function NewProjectDialog({
  open,
  workspace,
  onClose,
  onCreated
}: {
  open: boolean;
  workspace: NewProjectWorkspace;
  onClose(): void;
  onCreated(project: ProjectView): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const create = useCreateProjectMutation(t("projects.held"));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState<ProjectAudienceView>();
  const chosen = audience ?? workspace.defaultConversationVisibility;
  const shared = workspace.kind === "shared";

  function close() {
    if (create.isPending) return;
    setTitle("");
    setDescription("");
    setAudience(undefined);
    create.reset();
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === "" || create.isPending) return;
    create.mutate(
      {
        collaborationWorkspaceId: workspace.id,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(shared ? { audience: chosen } : {})
      },
      {
        onSuccess: (project) => {
          setTitle("");
          setDescription("");
          setAudience(undefined);
          onCreated(project);
        }
      }
    );
  }

  return (
    <Dialog
      open={open}
      title={t("projects.createTitle")}
      description={t("projects.createDescription", { workspace: workspace.name })}
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={create.isPending}>
            {t("projects.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={create.isPending}
            disabled={title.trim() === ""}
          >
            {t("projects.create")}
          </Button>
        </>
      }
    >
      <form id={formId} className="grid gap-5" onSubmit={submit}>
        <Field label={t("projects.fieldTitle")} required>
          <Input
            value={title}
            maxLength={120}
            autoFocus
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </Field>
        <Field label={t("projects.fieldDescription")} optional>
          <Textarea
            value={description}
            maxLength={500}
            rows={2}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </Field>
        {shared ? (
          <RadioGroup<ProjectAudienceView>
            label={t("projects.fieldAudience")}
            value={chosen}
            onValueChange={setAudience}
            options={[
              {
                value: "workspace",
                label: t("projects.audienceShared", { workspace: workspace.name }),
                description: t("projects.audienceSharedHint")
              },
              {
                value: "private",
                label: t("projects.audiencePrivate"),
                description: t("projects.audiencePrivateHint")
              }
            ]}
          />
        ) : null}
        {create.isError ? <FormNotice tone="error">{t("projects.createFailed")}</FormNotice> : null}
      </form>
    </Dialog>
  );
}
