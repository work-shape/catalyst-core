import { ArrowUp, Folder, Lock, MessageSquare, Plus, Users } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type {
  CollaborationWorkspaceWithRole,
  ConversationListItem,
  ProjectAudienceView,
  ProjectListItemView,
  ProjectView
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardTarget,
  CardTitle,
  ComposerFrame,
  Dialog,
  EmptyState,
  Field,
  FormNotice,
  InlineError,
  Input,
  NotFound,
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
  useProjectConversationsQuery,
  useProjectQuery,
  useProjectsQuery
} from "../../shared/api/projects";
import { AreaFrame, useAreaTitleFocus } from "../../shared/area-frame";
import { conversationTitle } from "../../shared/conversation-title";
import { useTranslation } from "../../shared/i18n";
import { formatDateTime } from "../../shared/locale-format";
import { workspaceRoutePath } from "../../shared/routes";
import { apiErrorStatus } from "../../shared/workspace-utils";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { RouteLink } from "../../studio/route-link";
import { ProjectFilesSection } from "./project-files-section";
import { ProjectInstructionsTile } from "./project-instructions";
import { ProjectComposerAgent, ProjectSetupTile } from "./project-setup";
import type { BuildWorkspace } from "../../shared/build-rights";

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
  route: Extract<WorkspaceRoute, { kind: "projects" } | { kind: "project" }>;
  workspace: ProjectsWorkspace;
  /** Every workspace of the person, in the selector's order. */
  workspaces: readonly ProjectsWorkspaceChoice[];
  onOpenRoute(route: WorkspaceRoute): void;
  onOpenConversation(collaborationWorkspaceId: string, conversationId: string): void;
  onStartChat(input: {
    text: string;
    collaborationWorkspaceId: string;
    projectId: string;
    /** The agent the person chose; without one the project's default, else the workspace's. */
    agentName?: string;
  }): Promise<void>;
}

/** The person's workspaces as the share of a greyed agent or skill names them (PRJ-7). */
function shareWorkspacesOf(workspaces: ProjectsAreaProps["workspaces"]): BuildWorkspace[] {
  return workspaces.map((entry) => ({
    id: entry.id,
    name: entry.name,
    member: true,
    ...(entry.kind === "personal" ? { personal: true as const } : {})
  }));
}

/**
 * The Projects area (PRJ-1): the projects of the open workspace or of all the person's
 * workspaces (PRJ-5), and one project's page.
 */
export function ProjectsArea(props: ProjectsAreaProps) {
  return props.route.kind === "projects" ? (
    <ProjectsPage key={props.workspace.id} {...props} />
  ) : (
    <ProjectPage key={props.route.project} {...props} projectName={props.route.project} />
  );
}

/** The audience of a project as a badge: shared with the workspace, or the lock of "Only me". */
function AudienceBadge({ project, workspace }: { project: ProjectView; workspace: string }) {
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
                  <AudienceBadge project={project} workspace={workspace.name} />
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

/** One project: its head, its conversations as cards and a composer that starts one in it. */
function ProjectPage({
  workspace,
  workspaces,
  projectName,
  onOpenRoute,
  onOpenConversation,
  onStartChat
}: ProjectsAreaProps & { projectName: string }) {
  const { t } = useTranslation();
  const areaRef = useAreaTitleFocus(true);
  const query = useProjectQuery(projectName);
  const project = query.data;
  const projectsRoute: WorkspaceRoute = {
    kind: "projects",
    collaborationWorkspaceId: workspace.id
  };

  if (query.isError && apiErrorStatus(query.error) === 404) {
    return (
      <AreaFrame ref={areaRef} label={t("projects.title")}>
        <NotFound
          icon={<Folder aria-hidden="true" />}
          data-testid="project-not-found"
          action={
            <Button variant="outline" onClick={() => onOpenRoute(projectsRoute)}>
              {t("projects.backToProjects")}
            </Button>
          }
        >
          {t("projects.notFound")}
        </NotFound>
      </AreaFrame>
    );
  }

  return (
    <AreaFrame ref={areaRef} label={project?.title ?? t("projects.title")}>
      <Page>
        {query.isPending ? (
          <SkeletonList rows={3} />
        ) : query.isError || !project ? (
          <InlineError className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("projects.loadFailed")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                query.refetch().catch(() => undefined);
              }}
            >
              {t("tryAgain")}
            </Button>
          </InlineError>
        ) : (
          <>
            <PageHeader
              back={
                <Breadcrumb
                  label={t("projects.way")}
                  items={[
                    {
                      id: "projects",
                      label: workspace.name,
                      href: workspaceRoutePath(projectsRoute),
                      onSelect: () => onOpenRoute(projectsRoute)
                    },
                    { id: project.id, label: project.title }
                  ]}
                />
              }
              title={project.title}
              state={<AudienceBadge project={project} workspace={workspace.name} />}
              description={project.description}
            />
            {/* The project's settings as tiles: two beside each other where the page has room. */}
            <div className="@container mb-8">
              <div className="grid gap-4 @2xl:grid-cols-2">
                <ProjectInstructionsTile project={project} />
                <ProjectSetupTile
                  project={project}
                  workspace={workspace}
                  workspaces={shareWorkspacesOf(workspaces)}
                />
              </div>
            </div>
            {/* The files stand beside the chats where the page has room, and below them where not. */}
            <div className="grid gap-8 @4xl/page:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)]">
              <div className="@container min-w-0">
                <ProjectConversations project={project} onOpenConversation={onOpenConversation} />
                <ProjectComposer
                  project={project}
                  workspace={workspace}
                  workspaces={workspaces}
                  onStartChat={onStartChat}
                />
              </div>
              <div className="min-w-0">
                <ProjectFilesSection
                  project={project}
                  onOpenConversation={(conversationId) =>
                    onOpenConversation(project.collaborationWorkspaceId, conversationId)
                  }
                />
              </div>
            </div>
          </>
        )}
      </Page>
    </AreaFrame>
  );
}

function ProjectConversations({
  project,
  onOpenConversation
}: {
  project: ProjectView;
  onOpenConversation: ProjectsAreaProps["onOpenConversation"];
}) {
  const { t, locale } = useTranslation();
  const conversations = useProjectConversationsQuery(project);
  return (
    <Section
      layout="stacked"
      title={t("projects.conversations")}
      count={conversations.data?.length}
    >
      {conversations.isPending ? (
        <SkeletonList rows={2} />
      ) : conversations.isError ? (
        <InlineError className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("projects.conversationsFailed")}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              conversations.refetch().catch(() => undefined);
            }}
          >
            {t("tryAgain")}
          </Button>
        </InlineError>
      ) : conversations.data.length === 0 ? (
        <EmptyState icon={<MessageSquare aria-hidden="true" />}>
          {t("projects.conversationsEmpty")}
        </EmptyState>
      ) : (
        <ul
          aria-label={t("projects.conversations")}
          className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3"
        >
          {conversations.data.map((conversation) => (
            <li key={conversation.id} className="flex min-w-0" data-testid="project-conversation">
              <ConversationCard
                conversation={conversation}
                updated={t("projects.updatedAt", {
                  date: formatDateTime(conversation.updatedAt, locale)
                })}
                onOpen={() =>
                  onOpenConversation(conversation.collaborationWorkspaceId, conversation.id)
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ConversationCard({
  conversation,
  updated,
  onOpen
}: {
  conversation: ConversationListItem;
  updated: string;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const title = conversationTitle(conversation.title, t);
  return (
    <Card padding="md" className="flex w-full min-w-0 flex-col">
      <CardHeader>
        <CardTitle clamp className="min-w-0">
          {title}
        </CardTitle>
        <p className="text-caption text-muted-foreground">{updated}</p>
      </CardHeader>
      <CardFooter>
        <CardTarget label={t("projects.openConversation", { title })} title={title}>
          <Button variant="outline" size="sm" onClick={onOpen}>
            {t("projects.openAction")}
          </Button>
        </CardTarget>
      </CardFooter>
    </Card>
  );
}

/** Starts a new chat in the project with its first message; the chat opens once it runs. */
function ProjectComposer({
  project,
  workspace,
  workspaces,
  onStartChat
}: {
  project: ProjectView;
  workspace: ProjectsWorkspace;
  workspaces: ProjectsAreaProps["workspaces"];
  onStartChat: ProjectsAreaProps["onStartChat"];
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  // Chosen here; until then the server starts the chat with the project's default agent.
  const [agentName, setAgentName] = useState<string>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = t("projects.composerLabel", { title: project.title });

  async function start(event?: FormEvent) {
    event?.preventDefault();
    const message = text.trim();
    if (message === "" || pending) return;
    setPending(true);
    setFailed(false);
    try {
      await onStartChat({
        text: message,
        collaborationWorkspaceId: project.collaborationWorkspaceId,
        projectId: project.id,
        ...(agentName ? { agentName } : {})
      });
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <form
      className="grid gap-2 pt-6"
      onSubmit={(event) => {
        start(event).catch(() => undefined);
      }}
    >
      <ComposerFrame className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1">
        <Textarea
          variant="composer"
          aria-label={label}
          data-testid="project-composer"
          rows={2}
          value={text}
          placeholder={t("projects.composerPlaceholder", { title: project.title })}
          disabled={pending}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              start().catch(() => undefined);
            }
          }}
        />
        <div className="flex min-w-0 items-center gap-1">
          <ProjectComposerAgent
            project={project}
            workspace={workspace}
            workspaces={shareWorkspacesOf(workspaces)}
            value={agentName}
            onChange={setAgentName}
          />
          <Button
            type="submit"
            size="icon"
            className="size-9 rounded-full"
            aria-label={t("projects.send")}
            title={t("projects.send")}
            loading={pending}
            disabled={text.trim() === ""}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
      </ComposerFrame>
      {failed ? <FormNotice tone="error">{t("projects.startFailed")}</FormNotice> : null}
    </form>
  );
}
