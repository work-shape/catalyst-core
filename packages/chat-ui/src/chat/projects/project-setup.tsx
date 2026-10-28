import { ChevronDown, Sparkles } from "lucide-react";
import { forwardRef, useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import type {
  ProjectAgentChoiceView,
  ProjectSetupView,
  ProjectSkillChoiceView,
  ProjectView
} from "@work-shape/catalyst-api-client";
import { PROJECT_SKILLS_MAX, type ProjectChoiceKind } from "@work-shape/catalyst-core";
import {
  Avatar,
  Banner,
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardTarget,
  CardTitle,
  Chip,
  Drawer,
  Field,
  FormNotice,
  InlineError,
  Picker,
  PickerButton,
  SkeletonList,
  SkillIcon,
  cn,
  type PickerDisabledAction,
  type PickerOption
} from "@work-shape/catalyst-ui";
import {
  useProjectSetupQuery,
  useRefreshProjectSetup,
  useSetProjectSetupMutation
} from "../../shared/api/projects";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import type { BuildWorkspace } from "../../shared/build-rights";
import { useTranslation } from "../../shared/i18n";
import { apiErrorCode } from "../../shared/workspace-utils";
import { useAssetShare } from "../../studio/build-area/asset-share";
import {
  createAssetShareSource,
  type AssetShareSubject,
  type AssetShareTarget
} from "../../studio/build-area/asset-share-model";

// A project's default agent and skills (PRJ-7). The default agent preselects the agent of a new
// chat in the project; the skills join every run's offer beside its agent's. Only what the
// project's audience may use can be chosen: a person's own agent or skill is greyed in a project
// others read, with the reason and the share that opens it to the workspace.

/** The "workspace's agent" row of the default-agent chooser; no agent name holds a colon. */
const WORKSPACE_DEFAULT = ":workspace";

/** Room for a greyed row's reason beside its share step, and no wider than a phone. */
export const PICKER_WIDTH = "w-[min(30rem,calc(100vw-2rem))]";

/** The workspace a project belongs to, as the page names it. */
export interface ProjectSetupWorkspace {
  id: string;
  name: string;
}

/** An agent or a skill the person may choose for the project now. */
function usable(choice: { refusal?: string }) {
  return choice.refusal === undefined;
}

/** The project's default agent where the person may still start a chat with it. */
function usableDefault(setup: ProjectSetupView) {
  const chosen = setup.agents.find((agent) => agent.name === setup.defaultAgent);
  return chosen && usable(chosen) ? chosen : undefined;
}

/** The project's skills that apply to its chats now, and the names that no longer do. */
function attachedSkills(setup: ProjectSetupView) {
  const byName = new Map(setup.skillChoices.map((skill) => [skill.name, skill]));
  const applied: ProjectSkillChoiceView[] = [];
  const unavailable: string[] = [];
  for (const name of setup.skills) {
    const skill = byName.get(name);
    if (skill && usable(skill)) applied.push(skill);
    else unavailable.push(skill?.title || name);
  }
  return { applied, unavailable };
}

/** The agent a new chat in the project starts with: its default, else the workspace's. */
function projectStartAgent(setup: ProjectSetupView | undefined) {
  if (!setup) return undefined;
  return (
    usableDefault(setup) ??
    setup.agents.find((agent) => agent.name === setup.workspaceDefaultAgent && usable(agent)) ??
    setup.agents.find(usable)
  );
}

/**
 * "Mit {team} teilen…" on a greyed choice: the person's own agent, skill or Knowledge Base moves
 * to the project's workspace in the same dialog as in Studio, and the choices are read again.
 */
export function useProjectChoiceShare(
  project: Pick<ProjectView, "id">,
  workspace: ProjectSetupWorkspace,
  workspaces: readonly BuildWorkspace[]
) {
  const { t } = useTranslation();
  const { client } = useWorkspaceApiClient();
  const refresh = useRefreshProjectSetup();
  const source = useMemo(
    () => (client ? createAssetShareSource(client, () => refresh(project.id)) : undefined),
    [client, project.id, refresh]
  );
  const [subject, setSubject] = useState<AssetShareSubject>();
  const share = useAssetShare({
    source,
    subject,
    canShare: true,
    workspaces,
    onMoved: () => {
      setSubject(undefined);
      refresh(project.id);
    }
  });
  const to: AssetShareTarget = {
    kind: "workspace",
    workspaceId: workspace.id,
    name: workspace.name
  };
  const action = (
    kind: ProjectChoiceKind,
    choice: { name: string; asset?: { id: string; workspaceId: string } },
    title: string
  ): PickerDisabledAction | undefined => {
    const asset = choice.asset;
    if (!asset || !source) return undefined;
    return {
      label: t("share.withTeam", { team: workspace.name }),
      onSelect: () => {
        setSubject({
          kind,
          name: choice.name,
          title,
          id: asset.id,
          owner: { kind: "workspace", workspaceId: asset.workspaceId }
        });
        share.open(to);
      }
    };
  };
  return { action, dialog: share.dialog };
}

/** The options of an agent chooser: those the person may choose, then the greyed ones. */
function agentOptions(
  agents: readonly ProjectAgentChoiceView[],
  reason: string,
  ownHint: string,
  action: (agent: ProjectAgentChoiceView) => PickerDisabledAction | undefined
): PickerOption[] {
  return [
    ...agents.filter(usable).map((agent) => ({
      value: agent.name,
      label: agent.displayName,
      ...(agent.own
        ? { description: ownHint }
        : agent.description
          ? { description: agent.description }
          : {}),
      leading: <Avatar kind="agent" name={agent.displayName} size="sm" />
    })),
    ...agents
      .filter((agent) => !usable(agent))
      .map((agent) => {
        const share = action(agent);
        return {
          value: agent.name,
          label: agent.displayName,
          disabled: true,
          disabledReason: reason,
          ...(share ? { disabledAction: share } : {}),
          leading: <Avatar kind="agent" name={agent.displayName} size="sm" />
        };
      })
  ];
}

// --- The tile and the panel on the project's page ----------------------------------------------

/** The "Skills & agent" tile beside the instructions: what is attached, and a warning where not. */
export function ProjectSetupTile({
  project,
  workspace,
  workspaces
}: {
  project: ProjectView;
  workspace: ProjectSetupWorkspace;
  workspaces: readonly BuildWorkspace[];
}) {
  const { t } = useTranslation();
  const setup = useProjectSetupQuery(project.id);
  const [open, setOpen] = useState(false);
  const data = setup.data;
  const agent = data ? usableDefault(data) : undefined;
  const skills = data ? attachedSkills(data) : undefined;
  const unavailable =
    data !== undefined &&
    ((data.defaultAgent !== undefined && agent === undefined) ||
      (skills?.unavailable.length ?? 0) > 0);
  const parts = [
    ...(skills?.applied.map((skill) => skill.title || skill.name) ?? []),
    ...(agent ? [agent.displayName] : [])
  ];
  const meta = setup.isPending
    ? "…"
    : setup.isError
      ? t("projectSetup.loadFailed")
      : parts.length === 0
        ? t("projectSetup.tileEmpty")
        : parts.join(" · ");
  return (
    <>
      <Card
        padding="md"
        className="min-w-0"
        data-testid="project-setup-tile"
        data-state={unavailable ? "unavailable" : parts.length === 0 ? "empty" : "set"}
      >
        <CardHeader className="grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3">
          <Sparkles aria-hidden="true" className="row-span-2 mt-0.5 size-4 text-muted-foreground" />
          <CardTitle>{t("projectSetup.title")}</CardTitle>
          <p className="text-caption text-muted-foreground wrap-anywhere">{meta}</p>
          {unavailable ? (
            <Banner layout="line" tone="warning" className="col-start-2">
              {t("projectSetup.tileUnavailable")}
            </Banner>
          ) : null}
        </CardHeader>
        <CardFooter>
          <CardTarget label={t("projectSetup.open")} title={t("projectSetup.title")}>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              {t("projectSetup.open")}
            </Button>
          </CardTarget>
        </CardFooter>
      </Card>
      <ProjectSetupPanel
        project={project}
        workspace={workspace}
        workspaces={workspaces}
        open={open}
        setup={data}
        failed={setup.isError}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** The default agent and the skills in the drawer beside the page, saved together. */
function ProjectSetupPanel({
  project,
  workspace,
  workspaces,
  open,
  setup,
  failed,
  onClose
}: {
  project: ProjectView;
  workspace: ProjectSetupWorkspace;
  workspaces: readonly BuildWorkspace[];
  open: boolean;
  setup: ProjectSetupView | undefined;
  failed: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const save = useSetProjectSetupMutation(project.id, t("projectFiles.held"));
  const share = useProjectChoiceShare(project, workspace, workspaces);
  // What the person changed since opening; unchanged parts show the project as it is now.
  const [agentDraft, setAgentDraft] = useState<{ name?: string }>();
  const [skillsDraft, setSkillsDraft] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const agent = agentDraft ? agentDraft.name : setup?.defaultAgent;
  const skills = skillsDraft ?? setup?.skills ?? [];
  const setAgent = (name: string | undefined) => setAgentDraft(name === undefined ? {} : { name });
  const setSkills = setSkillsDraft;

  // Each opening starts from the project as it is now.
  useEffect(() => {
    if (open) return;
    setAgentDraft(undefined);
    setSkillsDraft(undefined);
    setError(undefined);
    setSaved(false);
  }, [open]);

  const reason = t("projectSetup.ownInSharedProject");
  const ownHint = t("projectSetup.ownHint");
  const workspaceAgent = setup?.agents.find((entry) => entry.name === setup.workspaceDefaultAgent);
  const chosenAgent = setup?.agents.find((entry) => entry.name === agent);
  const agentApplies = agent === undefined || (chosenAgent !== undefined && usable(chosenAgent));
  const skillByName = new Map(setup?.skillChoices.map((skill) => [skill.name, skill]) ?? []);
  const unavailableSkills = skills.filter((name) => {
    const skill = skillByName.get(name);
    return !skill || !usable(skill);
  });
  const max = PROJECT_SKILLS_MAX;

  async function submit() {
    setError(undefined);
    setSaved(false);
    try {
      await save.mutateAsync({ defaultAgent: agent ?? null, skills });
      setSaved(true);
    } catch (failure) {
      const code = apiErrorCode(failure);
      setError(
        code === "VALIDATION_FAILED"
          ? t("projectSetup.refused")
          : code === "CONFLICT"
            ? t("projectSetup.changedMeanwhile")
            : t("projectSetup.saveFailed")
      );
    }
  }

  const footer = (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        loading={save.isPending}
        disabled={!setup}
        data-testid="project-setup-save"
        onClick={() => {
          submit().catch(() => undefined);
        }}
      >
        {t("projectSetup.save")}
      </Button>
      <Button variant="outline" size="sm" disabled={save.isPending} onClick={onClose}>
        {t("projectSetup.cancel")}
      </Button>
    </div>
  );

  return (
    <Drawer
      open={open}
      title={t("projectSetup.title")}
      description={project.title}
      onClose={onClose}
      className="w-[min(40rem,100vw)]"
      footer={footer}
    >
      <div className="grid gap-6" data-testid="project-setup-panel">
        <p className="text-body text-muted-foreground">
          {t("projectSetup.panelLead", { project: project.title })}
        </p>
        {error ? <FormNotice tone="error">{error}</FormNotice> : null}
        {saved ? <FormNotice tone="success">{t("projectSetup.saved")}</FormNotice> : null}
        {failed ? (
          <InlineError>{t("projectSetup.loadFailed")}</InlineError>
        ) : !setup ? (
          <SkeletonList rows={3} />
        ) : (
          <>
            <Field label={t("projectSetup.agentField")} hint={t("projectSetup.agentHint")}>
              <Picker
                search={setup.agents.length > 7}
                wrapDescriptions
                className={PICKER_WIDTH}
                label={t("projectSetup.chooseAgent")}
                options={[
                  {
                    value: WORKSPACE_DEFAULT,
                    label: t("projectSetup.workspaceDefault"),
                    ...(workspaceAgent
                      ? {
                          description: t("projectSetup.workspaceDefaultIs", {
                            agent: workspaceAgent.displayName
                          })
                        }
                      : {})
                  },
                  ...agentOptions(setup.agents, reason, ownHint, (entry) =>
                    share.action("agent", entry, entry.displayName)
                  )
                ]}
                value={agent ?? WORKSPACE_DEFAULT}
                onValueChange={(value) => setAgent(value === WORKSPACE_DEFAULT ? undefined : value)}
              >
                <PickerButton
                  label={t("projectSetup.agentField")}
                  placeholder={t("projectSetup.chooseAgent")}
                  data-testid="project-setup-agent"
                  value={
                    agent === undefined
                      ? t("projectSetup.workspaceDefault")
                      : (chosenAgent?.displayName ?? agent)
                  }
                  {...(chosenAgent
                    ? { leading: <Avatar kind="agent" name={chosenAgent.displayName} size="sm" /> }
                    : {})}
                />
              </Picker>
            </Field>
            {!agentApplies ? (
              <Banner layout="line" tone="warning" data-testid="project-setup-agent-unavailable">
                {t("projectSetup.agentUnavailable", {
                  agent: chosenAgent?.displayName ?? agent ?? ""
                })}
              </Banner>
            ) : null}
            <section className="grid gap-3" aria-labelledby="project-setup-skills">
              <div className="grid gap-1">
                <h3 id="project-setup-skills" className="text-label font-medium">
                  {t("projectSetup.skillsField")}
                </h3>
                <p className="text-caption text-muted-foreground">
                  {t("projectSetup.skillsHint", { max })}
                </p>
              </div>
              {skills.length === 0 ? (
                <p className="text-body text-muted-foreground">{t("projectSetup.noSkills")}</p>
              ) : (
                <ul
                  aria-label={t("projectSetup.skillsField")}
                  className="flex flex-wrap gap-2"
                  data-testid="project-setup-skills"
                >
                  {skills.map((name) => {
                    const skill = skillByName.get(name);
                    const title = skill?.title || name;
                    const applies = skill !== undefined && usable(skill);
                    return (
                      <li key={name} data-state={applies ? "applies" : "unavailable"}>
                        <Chip
                          leading={<SkillIcon icon={skill?.icon} size="sm" />}
                          className={cn(!applies && "text-muted-foreground line-through")}
                          onRemove={() => setSkills(skills.filter((entry) => entry !== name))}
                        >
                          {applies ? title : t("projectSetup.unavailableChip", { name: title })}
                        </Chip>
                      </li>
                    );
                  })}
                </ul>
              )}
              {unavailableSkills.length > 0 ? (
                <Banner layout="line" tone="warning" data-testid="project-setup-skills-unavailable">
                  {t("projectSetup.skillsUnavailable", {
                    skills: unavailableSkills
                      .map((name) => skillByName.get(name)?.title || name)
                      .join(", ")
                  })}
                </Banner>
              ) : null}
              <div>
                <Picker
                  multiple
                  search
                  wrapDescriptions
                  className={PICKER_WIDTH}
                  label={t("projectSetup.chooseSkills")}
                  options={[
                    ...setup.skillChoices.filter(usable).map((skill) => ({
                      value: skill.name,
                      label: skill.title || skill.name,
                      ...(skill.own
                        ? { description: ownHint }
                        : skill.summary
                          ? { description: skill.summary }
                          : {}),
                      keywords: skill.name,
                      leading: <SkillIcon icon={skill.icon} />
                    })),
                    ...setup.skillChoices
                      .filter((skill) => !usable(skill))
                      .map((skill) => {
                        const action = share.action("skill", skill, skill.title || skill.name);
                        return {
                          value: skill.name,
                          label: skill.title || skill.name,
                          disabled: true,
                          disabledReason: reason,
                          ...(action ? { disabledAction: action } : {}),
                          keywords: skill.name,
                          leading: <SkillIcon icon={skill.icon} />
                        };
                      })
                  ]}
                  value={skills}
                  onValueChange={(next) => setSkills(next.slice(0, max))}
                >
                  <PickerButton
                    label={t("projectSetup.skillsField")}
                    placeholder={t("projectSetup.chooseSkills")}
                    data-testid="project-setup-add-skills"
                    value={undefined}
                  />
                </Picker>
              </div>
            </section>
          </>
        )}
      </div>
      {share.dialog}
    </Drawer>
  );
}

// --- The agent of a new chat, in the composer --------------------------------------------------

/**
 * The agent a new chat in the project starts with, beside the composer's send button: the
 * project's default where it applies, else the workspace's. Nothing where there is no choice.
 */
export function ProjectComposerAgent({
  project,
  workspace,
  workspaces,
  value,
  onChange
}: {
  project: ProjectView;
  workspace: ProjectSetupWorkspace;
  workspaces: readonly BuildWorkspace[];
  value: string | undefined;
  onChange(agentName: string): void;
}) {
  const { t } = useTranslation();
  const setup = useProjectSetupQuery(project.id);
  const share = useProjectChoiceShare(project, workspace, workspaces);
  const [open, setOpen] = useState(false);
  const data = setup.data;
  if (!data) return null;
  const greyed = data.agents.some((agent) => !usable(agent));
  const usableAgents = data.agents.filter(usable);
  const chosen = usableAgents.find((agent) => agent.name === value) ?? projectStartAgent(data);
  if (!chosen || (usableAgents.length < 2 && !greyed)) return null;
  return (
    <>
      <Picker
        wrapDescriptions
        className={PICKER_WIDTH}
        label={t("projectSetup.composerAgent")}
        options={agentOptions(
          data.agents,
          t("projectSetup.ownInSharedProject"),
          t("projectSetup.ownHint"),
          (agent) => share.action("agent", agent, agent.displayName)
        )}
        value={chosen.name}
        open={open}
        onOpenChange={setOpen}
        align="end"
        side="top"
        onValueChange={onChange}
      >
        <ComposerAgentButton label={chosen.displayName} open={open} />
      </Picker>
      {share.dialog}
    </>
  );
}

const ComposerAgentButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { label: string; open: boolean }
>(function ComposerAgentButton({ label, open, className, ...trigger }, ref) {
  const { t } = useTranslation();
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      {...trigger}
      data-testid="project-composer-agent"
      className={cn("h-9 max-w-48 min-w-0 gap-1.5 px-2", className)}
      aria-label={`${t("projectSetup.composerAgent")}: ${label}`}
      title={label}
    >
      <Avatar kind="agent" name={label} size="sm" className="pointer-events-none" />
      <span className="min-w-0 truncate text-label">{label}</span>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-180"
        )}
      />
    </Button>
  );
});
