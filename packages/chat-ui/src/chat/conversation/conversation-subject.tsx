import { createContext, useContext, useState, type MouseEvent } from "react";
import { ArrowRight, FileText } from "lucide-react";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-client";
import { DATA_STORE_ASSET_KIND, WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import {
  Banner,
  Button,
  RegistryIcon,
  TextLink,
  type GenericIconKey
} from "@work-shape/catalyst-ui";
import { opensHere } from "../../studio/apps/app-header";
import { AGENT_ASSET_KIND } from "../../shared/build-rights";
import { useTranslation } from "../../shared/i18n";
import { workspaceRoutePath, type WorkspaceRoute } from "../../shared/routes";
import { routeLink } from "../../studio/workflows/workflows-frame";
import { assetPageRoute, type AssetOpen } from "./subject-run";
import type { AgentOpens } from "./use-agent-opens";

/** The asset a conversation is about, as the conversation carries it. */
export interface ConversationSubjectView {
  kind: string;
  name: string;
}

const SUBJECT_ICONS: Readonly<Record<string, GenericIconKey>> = {
  [WORKFLOW_ASSET_KIND]: "workflow",
  [APP_ASSET_KIND]: "app",
  [AGENT_ASSET_KIND]: "agent",
  [DATA_STORE_ASSET_KIND]: "datastore",
  skill: "skill"
};

/** The kind's icon from the registry, the same as on the rail and in Studio. */
function SubjectIcon({ kind }: { kind: string }) {
  const icon = SUBJECT_ICONS[kind];
  return icon === undefined ? <FileText aria-hidden="true" /> : <RegistryIcon name={icon} />;
}

/**
 * Says over the composer what the open conversation is about, from its first empty moment on:
 * "Working on:" and the asset's name, which leads to its page with the conversation in the dock.
 */
export function ConversationSubjectLine({
  subject,
  title,
  workspaceId,
  onOpenRoute
}: {
  subject: ConversationSubjectView;
  /** The name people read for the asset. */
  title: string;
  workspaceId: string | undefined;
  onOpenRoute(route: WorkspaceRoute): void;
}) {
  const { t } = useTranslation();
  const route = assetPageRoute(subject, workspaceId);
  return (
    <Banner
      layout="line"
      icon={<SubjectIcon kind={subject.kind} />}
      className="mb-2 px-1"
      data-testid="conversation-subject"
      data-subject-kind={subject.kind}
    >
      {route === undefined ? (
        t("conversationSubjectOther", { name: title })
      ) : (
        <>
          {t("conversationSubjectWorkingOn")}{" "}
          <TextLink {...routeLink(route, onOpenRoute)}>{title}</TextLink>
        </>
      )}
    </Banner>
  );
}

/**
 * "Opened <name> · Go to it": an asset the agent opened that the person was not taken to, in
 * another tab, from a page they went to on their own, after a reload, or one that waits for the
 * person. The press is the person's own step to it. Going to one that waits for the person first
 * makes it the conversation's subject, so the button shows that it works until the page opens.
 */
export function AssetOpenedChip({
  open,
  onGoTo
}: {
  open: AssetOpen;
  onGoTo(open: AssetOpen): Promise<void>;
}) {
  const { t } = useTranslation();
  const [going, setGoing] = useState(false);
  const goTo = () => {
    setGoing(true);
    onGoTo(open)
      .catch(() => undefined)
      .finally(() => setGoing(false));
  };
  return (
    <Banner
      tone="info"
      icon={<SubjectIcon kind={open.subject.kind} />}
      className="mb-2"
      data-testid="asset-opened-chip"
      data-awaits-person={open.awaitsPerson ? "" : undefined}
      action={
        <Button variant="secondary" size="sm" loading={going} onClick={goTo}>
          {t("conversationOpenedGoTo")}
          <ArrowRight aria-hidden="true" />
        </Button>
      }
    >
      {t("conversationOpened", { name: open.title })}
      {open.awaitsPerson ? (
        <span className="block text-muted-foreground">{t("conversationOpenedWaits")}</span>
      ) : null}
    </Banner>
  );
}

const NAME_MARK = "\u0000";

const AgentOpensContext = createContext<AgentOpens | undefined>(undefined);

/** Gives the lines of the thread the way to the pages of the assets the agent opened. */
export const AgentOpensProvider = AgentOpensContext.Provider;

/** What the created line says, by the kind of the asset the agent created. */
function createdKeyOf(kind: string) {
  switch (kind) {
    case WORKFLOW_ASSET_KIND:
      return "conversationCreatedWorkflow";
    case DATA_STORE_ASSET_KIND:
      return "conversationCreatedDataStore";
    case AGENT_ASSET_KIND:
      return "conversationCreatedAgent";
    case "skill":
      return "conversationCreatedSkill";
    default:
      return "conversationCreatedOther";
  }
}

/**
 * The line a draft the agent created beside the subject leaves in the conversation (BUILD-ALL-1):
 * "Workflow draft “<name>” created · Open". Nobody was moved; "Open" leads to its page with the
 * conversation in the dock, which stays about its subject.
 */
function AssetCreatedLine({ open }: { open: AssetOpen }) {
  const { t } = useTranslation();
  const opens = useContext(AgentOpensContext);
  const route = opens?.pageOf(open);
  return (
    <p
      className="chat-tool-part my-1 flex max-w-3xl items-center gap-2 text-xs text-muted-foreground"
      data-testid="asset-created-line"
      data-subject-kind={open.subject.kind}
    >
      <span className="flex h-4 shrink-0 items-center [&>svg]:size-3.5">
        <SubjectIcon kind={open.subject.kind} />
      </span>
      <span className="min-w-0 truncate">
        {t(createdKeyOf(open.subject.kind), { name: open.title })}
        {route === undefined || opens === undefined ? null : (
          <>
            {" · "}
            <TextLink
              href={workspaceRoutePath(route)}
              onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                if (opensHere(event)) {
                  event.preventDefault();
                  opens.goTo(open).catch(() => undefined);
                }
              }}
            >
              {t("conversationCreatedOpen")}
            </TextLink>
          </>
        )}
      </span>
    </p>
  );
}

/**
 * The line every open leaves in the conversation: "Opened <name>", the name leading to the
 * asset's page. Where the thread has no workspace to lead to, the name stands alone. A draft
 * created beside the subject leaves its created line instead.
 */
export function AssetOpenedLine({ open }: { open: AssetOpen }) {
  if (open.besideSubject) return <AssetCreatedLine open={open} />;
  return <OpenedLine open={open} />;
}

function OpenedLine({ open }: { open: AssetOpen }) {
  const { t } = useTranslation();
  const opens = useContext(AgentOpensContext);
  const route = opens?.pageOf(open);
  // The name is set apart in the sentence, wherever the language puts it.
  const [before, after = ""] = t("conversationOpened", { name: NAME_MARK }).split(NAME_MARK);
  return (
    <p
      className="chat-tool-part my-1 flex max-w-3xl items-center gap-2 text-xs text-muted-foreground"
      data-testid="asset-opened-line"
      data-subject-kind={open.subject.kind}
    >
      <span className="flex h-4 shrink-0 items-center [&>svg]:size-3.5">
        <SubjectIcon kind={open.subject.kind} />
      </span>
      <span className="min-w-0 truncate">
        {before}
        {route === undefined || opens === undefined ? (
          <span className="font-medium text-foreground">{open.title}</span>
        ) : (
          <TextLink
            href={workspaceRoutePath(route)}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (opensHere(event)) {
                event.preventDefault();
                opens.goTo(open).catch(() => undefined);
              }
            }}
          >
            {open.title}
          </TextLink>
        )}
        {after}
      </span>
    </p>
  );
}
