import { ArrowUp, Folder, Lock, MessageSquare, Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type {
  CollaborationWorkspaceWithRole,
  ConversationListItem,
  ProjectAudienceView,
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
  Section,
  SkeletonList,
  Textarea
} from "@work-shape/catalyst-ui";
import {
  useCreateProjectMutation,
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

/** The workspace the projects belong to, as the pages name it. */
interface ProjectsWorkspace {
  id: string;
  /** Its name as the interface shows it; a Personal Workspace's is its owner's. */
  name: string;
  kind: CollaborationWorkspaceWithRole["kind"];
  defaultConversationVisibility: ProjectAudienceView;
}

interface ProjectsAreaProps {
  route: Extract<WorkspaceRoute, { kind: "projects" } | { kind: "project" }>;
  workspace: ProjectsWorkspace;
  onOpenRoute(route: WorkspaceRoute): void;
  onOpenConversation(collaborationWorkspaceId: string, conversationId: string): void;
  onStartChat(input: {
    text: string;
    collaborationWorkspaceId: string;
    projectId: string;
  }): Promise<void>;
}

/** The Projects area (PRJ-1): the projects of the open workspace, and one project's page. */
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
    <Badge size="sm" tone="accent" data-testid="project-audience-shared">
      {t("projects.audienceShared", { workspace })}
    </Badge>
  );
}

function ProjectsPage({ workspace, onOpenRoute }: ProjectsAreaProps) {
  const { t } = useTranslation();
  const areaRef = useAreaTitleFocus(true);
  const list = useProjectsQuery(workspace.id);
  const [creating, setCreating] = useState(false);

  return (
    <AreaFrame ref={areaRef} label={t("projects.title")}>
      <Page>
        <PageHeader
          title={t("projects.title")}
          description={t("projects.description", { workspace: workspace.name })}
          primaryAction={
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("projects.new")}
            </Button>
          }
        />
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
        ) : list.data.length === 0 ? (
          <EmptyState icon={<Folder aria-hidden="true" />}>{t("projects.empty")}</EmptyState>
        ) : (
          <ul aria-label={t("projects.title")} className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
            {list.data.map((project) => {
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
                    <CardFooter>
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
 * Makes a project in the open workspace: its name, a description and who sees it. The choice
 * starts at the workspace's default for conversations; a Personal Workspace has none.
 */
function NewProjectDialog({
  open,
  workspace,
  onClose,
  onCreated
}: {
  open: boolean;
  workspace: ProjectsWorkspace;
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
            <ProjectConversations project={project} onOpenConversation={onOpenConversation} />
            <ProjectComposer project={project} onStartChat={onStartChat} />
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
  onStartChat
}: {
  project: ProjectView;
  onStartChat: ProjectsAreaProps["onStartChat"];
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
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
        projectId: project.id
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
      </ComposerFrame>
      {failed ? <FormNotice tone="error">{t("projects.startFailed")}</FormNotice> : null}
    </form>
  );
}
