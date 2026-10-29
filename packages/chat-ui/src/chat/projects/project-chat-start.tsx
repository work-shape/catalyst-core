import { Folder, Library, MoreHorizontal, ScrollText, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { ProjectView } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  Chip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  InlineError,
  List,
  ListRow,
  NotFound,
  Skeleton
} from "@work-shape/catalyst-ui";
import { useProjectFilesQuery } from "../../shared/api/project-files";
import {
  useProjectConversationsQuery,
  useProjectQuery,
  useProjectSetupQuery
} from "../../shared/api/projects";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useWorkspaceMeQuery } from "../../shared/api/workspace-queries";
import type { BuildWorkspace } from "../../shared/build-rights";
import { conversationTitle } from "../../shared/conversation-title";
import { useTranslation } from "../../shared/i18n";
import { formatDayShort } from "../../shared/locale-format";
import { apiErrorStatus } from "../../shared/workspace-utils";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { ChatStartProvider, type ChatStart } from "../assistant/chat-start";
import { ChatDropOverlay, hasDraggedFiles } from "../files/chat-file-dropzone";
import { useToolDisplayPanel } from "../tools/tool-display-panel";
import { droppedUploads } from "./project-files-model";
import {
  ProjectFilesSection,
  ProjectUploadsProvider,
  useProjectUploads
} from "./project-files-section";
import { ProjectInstructionsPanel, projectInstructionsEmpty } from "./project-instructions";
import { PROJECT_INSTRUCTIONS_PATH } from "./project-instructions-model";
import { ProjectKnowledgeDrawer, projectKnowledgeUnavailable } from "./project-knowledge";
import {
  ProjectSettingsDialogs,
  ProjectSettingsMenu,
  type ProjectSetting,
  type ProjectSettingsWorkspace
} from "./project-settings-dialogs";
import { ProjectSetupDrawer, projectSetupUnavailable } from "./project-setup";
import { ProjectAudienceBadge } from "./project-audience-badge";
import { useProjectStart } from "./project-start";

// A project's page is the start page of a chat in it (Felix, 2026-10-29): the start page's own
// composer in its own place, the project's name above it, and under it a row of small controls
// and the project's chats. Its instructions and its files open in the surface beside the page.

/** A workspace of the person, as the project's page names it. */
export interface ProjectStartWorkspace extends ProjectSettingsWorkspace {
  emoji: string | null;
}

/** What opens beside the page: the project's instructions or its files. */
type ProjectPanel = "instructions" | "files";

/** What else the "…" menu opens: the project's agent and skills, or its Knowledge Bases. */
type ProjectDrawer = "setup" | "knowledge";

function panelKey(panel: ProjectPanel, projectId: string): string {
  return `project-${panel}:${projectId}`;
}

/** The workspaces as the share of a greyed agent, skill or Knowledge Base names them (PRJ-7). */
function shareWorkspacesOf(workspaces: readonly ProjectStartWorkspace[]): BuildWorkspace[] {
  return workspaces.map((entry) => ({
    id: entry.id,
    name: entry.name,
    member: true,
    ...(entry.kind === "personal" ? { personal: true as const } : {})
  }));
}

/**
 * The start page of a chat in the project of the address, around the chat column it is given:
 * its parts of the start page, the drop of files anywhere on it into the project, and what its
 * controls open. A project the person cannot read says so in place of the column.
 */
export function ProjectChatStart({
  projectName,
  workspace,
  workspaces,
  onOpenRoute,
  onOpenConversation,
  children
}: {
  projectName: string;
  workspace: ProjectStartWorkspace;
  workspaces: readonly ProjectStartWorkspace[];
  onOpenRoute(route: WorkspaceRoute): void;
  onOpenConversation(collaborationWorkspaceId: string, conversationId: string): void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const query = useProjectQuery(projectName);
  const { project, agentNames } = useProjectStart(projectName);

  if (query.isError && apiErrorStatus(query.error) === 404) {
    return (
      <NotFound
        icon={<Folder aria-hidden="true" />}
        data-testid="project-not-found"
        action={
          <Button
            variant="outline"
            onClick={() =>
              onOpenRoute({ kind: "projects", collaborationWorkspaceId: workspace.id })
            }
          >
            {t("projects.backToProjects")}
          </Button>
        }
      >
        {t("projects.notFound")}
      </NotFound>
    );
  }

  if (!project) {
    return (
      <ChatStartProvider
        value={{
          heading: query.isError ? (
            <InlineError>{t("projects.loadFailed")}</InlineError>
          ) : (
            <Skeleton className="h-8 w-48" />
          ),
          below: null
        }}
      >
        {children}
      </ChatStartProvider>
    );
  }

  return (
    <ProjectStartPage
      key={project.id}
      project={project}
      agentNames={agentNames}
      workspace={workspace}
      workspaces={workspaces}
      onOpenRoute={onOpenRoute}
      onOpenConversation={onOpenConversation}
    >
      {children}
    </ProjectStartPage>
  );
}

function ProjectStartPage({
  project,
  agentNames,
  workspace,
  workspaces,
  onOpenRoute,
  onOpenConversation,
  children
}: {
  project: ProjectView;
  agentNames: ReadonlySet<string> | undefined;
  workspace: ProjectStartWorkspace;
  workspaces: readonly ProjectStartWorkspace[];
  onOpenRoute(route: WorkspaceRoute): void;
  onOpenConversation(collaborationWorkspaceId: string, conversationId: string): void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const uploads = useProjectUploads(project);
  const panel = useToolDisplayPanel();
  const [setting, setSetting] = useState<ProjectSetting>();
  const [drawer, setDrawer] = useState<ProjectDrawer>();
  const [dragging, setDragging] = useState(false);
  const shareWorkspaces = useMemo(() => shareWorkspacesOf(workspaces), [workspaces]);
  const openConversation = (conversationId: string) =>
    onOpenConversation(project.collaborationWorkspaceId, conversationId);
  const shownPanel =
    panel.open && panel.entry?.kind === "project_panel"
      ? (["instructions", "files"] as const).find(
          (entry) => panel.entry?.key === panelKey(entry, project.id)
        )
      : undefined;

  function showPanel(which: ProjectPanel) {
    panel.show(
      which === "instructions"
        ? {
            kind: "project_panel",
            key: panelKey(which, project.id),
            title: t("projectInstructions.title"),
            subtitle: PROJECT_INSTRUCTIONS_PATH,
            titleIcon: <ScrollText aria-hidden="true" />,
            node: <ProjectInstructionsPanel project={project} />
          }
        : {
            kind: "project_panel",
            key: panelKey(which, project.id),
            title: t("projectFiles.title"),
            subtitle: project.title,
            titleIcon: <Folder aria-hidden="true" />,
            node: <ProjectFilesSection project={project} onOpenConversation={openConversation} />
          }
    );
  }

  // What the page opened beside it closes with the page: a chat started here opens alone.
  const panelRef = useRef(panel);
  panelRef.current = panel;
  useEffect(
    () => () => {
      if (panelRef.current.entry?.kind === "project_panel") panelRef.current.close();
    },
    []
  );

  function dragOver(event: DragEvent<HTMLElement>) {
    // A drop zone inside the page, such as the one beside the file tree, takes its own drop.
    if (event.defaultPrevented || !hasDraggedFiles(event) || uploads.busy) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  const start: ChatStart = {
    heading: <ProjectStartHeading project={project} workspace={workspace} />,
    composerLabel: t("projects.composerLabel", { title: project.title }),
    composerChip: (
      <span className="inline-flex min-w-0 max-w-full" data-testid="project-composer-chip">
        <Chip size="sm" leading={<Folder aria-hidden="true" className="text-muted-foreground" />}>
          {project.title}
        </Chip>
      </span>
    ),
    below: (
      <ProjectStartBelow
        project={project}
        shownPanel={shownPanel}
        menu={
          <ProjectStartMenu
            project={project}
            workspace={workspace}
            workspaces={workspaces}
            onSetting={setSetting}
            onDrawer={setDrawer}
          />
        }
        onTogglePanel={(which) => {
          if (shownPanel === which) panel.close({ restoreFocus: true });
          else showPanel(which);
        }}
        onDrawer={setDrawer}
        onOpenConversation={openConversation}
      />
    ),
    ...(agentNames ? { agentNames } : {})
  };

  return (
    <ProjectUploadsProvider value={uploads}>
      <ChatStartProvider value={start}>
        <div
          className="relative h-full min-h-0 min-w-0"
          data-testid="project-start"
          onDragEnter={dragOver}
          onDragOver={dragOver}
          onDragLeave={(event) => {
            const to = event.relatedTarget;
            if (to instanceof Node && event.currentTarget.contains(to)) return;
            setDragging(false);
          }}
          onDrop={(event) => {
            setDragging(false);
            if (event.defaultPrevented || !hasDraggedFiles(event) || uploads.busy) return;
            event.preventDefault();
            uploads.take(droppedUploads(event.dataTransfer)).catch(() => undefined);
            // The uploads show where the project's files are.
            if (shownPanel !== "files") showPanel("files");
          }}
        >
          {children}
          {dragging ? (
            <ChatDropOverlay
              title={t("projects.dropTitle")}
              description={t("projects.dropDescription", { title: project.title })}
            />
          ) : null}
        </div>
        {uploads.dialogs}
        <ProjectSettingsDialogs
          open={setting}
          project={project}
          workspace={workspace}
          workspaces={workspaces}
          onClose={() => setSetting(undefined)}
          onMoved={(moved) => {
            setSetting(undefined);
            onOpenRoute({
              kind: "project",
              collaborationWorkspaceId: moved.collaborationWorkspaceId,
              project: moved.name
            });
          }}
          onDeleted={() => {
            setSetting(undefined);
            onOpenRoute({ kind: "projects", collaborationWorkspaceId: workspace.id });
          }}
        />
        <ProjectSetupDrawer
          project={project}
          workspace={workspace}
          workspaces={shareWorkspaces}
          open={drawer === "setup"}
          onClose={() => setDrawer(undefined)}
        />
        <ProjectKnowledgeDrawer
          project={project}
          workspace={workspace}
          workspaces={shareWorkspaces}
          open={drawer === "knowledge"}
          onClose={() => setDrawer(undefined)}
        />
      </ChatStartProvider>
    </ProjectUploadsProvider>
  );
}

/** The project's name above the composer, with the mark of who sees it. */
function ProjectStartHeading({
  project,
  workspace
}: {
  project: ProjectView;
  workspace: ProjectStartWorkspace;
}) {
  return (
    <div
      className="flex max-w-full min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1"
      data-testid="project-start-heading"
    >
      <h2 className="flex min-w-0 items-center gap-2 text-title-lg">
        <Folder aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{project.title}</span>
      </h2>
      <ProjectAudienceBadge project={project} workspace={workspace.name} />
    </div>
  );
}

/** Under the composer: the row of small controls, a warning where set-up stopped applying, the chats. */
function ProjectStartBelow({
  project,
  shownPanel,
  menu,
  onTogglePanel,
  onDrawer,
  onOpenConversation
}: {
  project: ProjectView;
  shownPanel: ProjectPanel | undefined;
  menu: ReactNode;
  onTogglePanel(panel: ProjectPanel): void;
  onDrawer(drawer: ProjectDrawer): void;
  onOpenConversation(conversationId: string): void;
}) {
  const { t } = useTranslation();
  const files = useProjectFilesQuery(project.id);
  const setup = useProjectSetupQuery(project.id).data;
  const empty = files.data !== undefined && projectInstructionsEmpty(files.data);
  return (
    <div className="grid gap-6">
      <div className="-mt-2 grid gap-2">
        <div className="flex flex-wrap items-center gap-1" data-testid="project-start-controls">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            aria-expanded={shownPanel === "instructions"}
            data-testid="project-open-instructions"
            data-state={empty ? "empty" : "written"}
            onClick={() => onTogglePanel("instructions")}
          >
            <ScrollText aria-hidden="true" />
            {t("projectInstructions.title")}
            {empty ? (
              <>
                <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                <span className="sr-only">{t("projectInstructions.noneYet")}</span>
              </>
            ) : null}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            aria-expanded={shownPanel === "files"}
            data-testid="project-open-files"
            onClick={() => onTogglePanel("files")}
          >
            <Folder aria-hidden="true" />
            {files.data
              ? `${t("projectFiles.title")} · ${files.data.usage.files}`
              : t("projectFiles.title")}
          </Button>
          {menu}
        </div>
        {setup && projectSetupUnavailable(setup) ? (
          <Banner
            layout="line"
            tone="warning"
            title={t("projectSetup.title")}
            data-testid="project-start-setup-unavailable"
            action={
              <Button variant="outline" size="sm" onClick={() => onDrawer("setup")}>
                {t("projects.openAction")}
              </Button>
            }
          >
            {t("projectSetup.tileUnavailable")}
          </Banner>
        ) : null}
        {setup && projectKnowledgeUnavailable(setup) ? (
          <Banner
            layout="line"
            tone="warning"
            title={t("projectKnowledge.title")}
            data-testid="project-start-knowledge-unavailable"
            action={
              <Button variant="outline" size="sm" onClick={() => onDrawer("knowledge")}>
                {t("projects.openAction")}
              </Button>
            }
          >
            {t("projectKnowledge.tileUnavailable")}
          </Banner>
        ) : null}
      </div>
      <ProjectStartChats project={project} onOpenConversation={onOpenConversation} />
    </div>
  );
}

/** The project's chats, newest first, as plain rows; nothing where there are none. */
function ProjectStartChats({
  project,
  onOpenConversation
}: {
  project: ProjectView;
  onOpenConversation(conversationId: string): void;
}) {
  const { t, locale } = useTranslation();
  const conversations = useProjectConversationsQuery(project);
  if (conversations.isError) {
    return (
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
    );
  }
  if (!conversations.data || conversations.data.length === 0) return null;
  return (
    <List aria-label={t("projects.conversations")} data-testid="project-conversations">
      {conversations.data.map((conversation) => (
        <ListRow
          key={conversation.id}
          size="compact"
          data-testid="project-conversation"
          title={conversationTitle(conversation.title, t)}
          time={formatDayShort(conversation.updatedAt, locale)}
          onClick={() => onOpenConversation(conversation.id)}
        />
      ))}
    </List>
  );
}

/**
 * The "…" of the project: its agent and skills, its Knowledge Bases where the module is on, then
 * who sees it, the move to another workspace and its deletion.
 */
function ProjectStartMenu({
  project,
  workspace,
  workspaces,
  onSetting,
  onDrawer
}: {
  project: ProjectView;
  workspace: ProjectStartWorkspace;
  workspaces: readonly ProjectStartWorkspace[];
  onSetting(setting: ProjectSetting): void;
  onDrawer(drawer: ProjectDrawer): void;
}) {
  const { t } = useTranslation();
  const me = useWorkspaceMeQuery(useWorkspaceApiClient());
  const setup = useProjectSetupQuery(project.id).data;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="sm"
          className="text-muted-foreground"
          label={t("projects.menu")}
          data-testid="project-menu"
        >
          <MoreHorizontal aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem icon={<Sparkles aria-hidden="true" />} onSelect={() => onDrawer("setup")}>
          <span data-testid="project-menu-setup">{t("projectSetup.title")}</span>
        </DropdownMenuItem>
        {/* The module `knowledge` is off where the server lists no choices. */}
        {setup?.knowledgeBaseChoices !== undefined ? (
          <DropdownMenuItem
            icon={<Library aria-hidden="true" />}
            onSelect={() => onDrawer("knowledge")}
          >
            <span data-testid="project-menu-knowledge">{t("projectKnowledge.title")}</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <ProjectSettingsMenu
          project={project}
          workspace={workspace}
          workspaces={workspaces}
          currentUserId={me.data?.id}
          onOpen={onSetting}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
