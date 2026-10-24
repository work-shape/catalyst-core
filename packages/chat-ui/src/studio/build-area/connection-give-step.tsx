import { useEffect, useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  Checkbox,
  FormNotice,
  RadioGroup,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import {
  giveTools,
  planGive,
  type ConnectionGiveSource,
  type GiveAgent,
  type GiveConnection,
  type GiveOutcome,
  type GivePlan,
  type GiveTool
} from "./connection-give";

// The steps of "Einem Agenten geben" (CS-5d) inside a dialog: the agents the person may
// publish, then the confirmation that names the agent and the tools, then what happened. The
// dialog it stands in owns its frame: this hands it a title, a body and a footer, so the New
// connection dialog, the approval on the Connection's page and the card in the conversation
// show the same steps.

/** What a place that offers the give is handed. */
export interface ConnectionGiveHost {
  source: ConnectionGiveSource;
  /** The person signed in: a draft they wrote is their own. */
  viewerId: string;
  /** Opens an agent's page. Absent where the place has no way there. */
  openAgent?(name: string): void;
  /** An agent was written: what lists agents reads them again. */
  given?(): void;
}

type Load =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; connection: GiveConnection | undefined; agents: GiveAgent[] };

type Step =
  | { step: "pick" }
  | { step: "ask"; plan: Extract<GivePlan, { status: "ready" }> }
  /** Nothing is asked: the agent has the tools, somebody else's draft is open, a read failed. */
  | { step: "refused"; plan: Exclude<GivePlan, { status: "ready" }> }
  | { step: "done"; agent: GiveAgent; outcome: GiveOutcome };

export interface GiveSteps {
  title: string;
  body: ReactNode;
  footer: ReactNode;
  /** A read or a write is on its way: the dialog is not closed meanwhile. */
  busy: boolean;
}

/**
 * The give for one Connection. `suggested` is the agent chosen first, as the agent in the
 * conversation named it. `onBack` leaves the first step for the step before it, where there is
 * one; `onClose` ends the give.
 */
export function useGiveToAgent(input: {
  /** Absent where the place offers no give: nothing is read. */
  host: ConnectionGiveHost | undefined;
  /** The give is shown: only then are the agents and the tools read. */
  enabled?: boolean;
  connection: string;
  /** The Connection's own title, while the tools are read. */
  connectionTitle?: string;
  suggested?: string;
  onBack?(): void;
  onClose(): void;
  /** The agent was written: the outcome, and the tools the give added, as it asked them. */
  onGiven?(agent: GiveAgent, outcome: GiveOutcome, tools: readonly GiveTool[]): void;
}): GiveSteps {
  const { t } = useTranslation();
  const { host, connection, suggested, onBack, onClose } = input;
  const enabled = host !== undefined && input.enabled !== false;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<string | undefined>();
  const [step, setStep] = useState<Step>({ step: "pick" });
  const [publishDraft, setPublishDraft] = useState(false);
  const [busy, setBusy] = useState(false);

  const source = host?.source;
  useEffect(() => {
    if (!enabled || !source) return;
    let current = true;
    setLoad({ status: "loading" });
    Promise.all([source.connection(connection), source.agents()]).then(
      ([found, agents]) => {
        if (!current) return;
        setLoad({ status: "ready", connection: found, agents });
        setChosen(
          (was) => was ?? agents.find((agent) => agent.name === suggested)?.name ?? agents[0]?.name
        );
      },
      () => {
        if (current) setLoad({ status: "failed" });
      }
    );
    return () => {
      current = false;
    };
  }, [enabled, source, connection, suggested, attempt]);

  const ready = load.status === "ready" ? load : undefined;
  const connectionTitle = ready?.connection?.title ?? input.connectionTitle ?? connection;
  const agentOf = (name: string | undefined) => ready?.agents.find((agent) => agent.name === name);

  const plan = async () => {
    const agent = agentOf(chosen);
    if (!host || !agent || !ready?.connection) return;
    setBusy(true);
    const planned = await planGive(host.source, {
      agent,
      tools: ready.connection.tools,
      viewerId: host.viewerId
    });
    setBusy(false);
    setPublishDraft(false);
    setStep(
      planned.status === "ready"
        ? { step: "ask", plan: planned }
        : { step: "refused", plan: planned }
    );
  };

  const give = async (asked: Extract<GivePlan, { status: "ready" }>) => {
    const agent = agentOf(asked.agent);
    if (!host || !agent) return;
    setBusy(true);
    const outcome = await giveTools(host.source, asked, {
      publishDraft,
      viewerId: host.viewerId
    });
    setBusy(false);
    if (outcome.status !== "failed" && outcome.status !== "other_draft") {
      host.given?.();
      input.onGiven?.(agent, outcome, asked.tools);
    }
    setStep({ step: "done", agent, outcome });
  };

  const back = () => setStep({ step: "pick" });
  const openAgent = (name: string, title: string) =>
    host?.openAgent ? (
      <Button
        variant="outline"
        data-connection-give-open-agent=""
        onClick={() => host.openAgent?.(name)}
      >
        {t("connectionGive.openAgent", { agent: title })}
      </Button>
    ) : null;

  return {
    title: t("connectionGive.title"),
    busy,
    body: body(),
    footer: footer()
  };

  function body(): ReactNode {
    switch (step.step) {
      case "pick":
        return pickBody();
      case "ask":
        return askBody(step.plan);
      case "refused":
        return <RefusedNotice plan={step.plan} t={t} />;
      case "done":
        return (
          <OutcomeNotice
            outcome={step.outcome}
            agent={step.agent.title}
            connection={connectionTitle}
            t={t}
          />
        );
    }
  }

  function pickBody(): ReactNode {
    if (load.status === "loading") return <SkeletonList rows={3} />;
    if (load.status === "failed") {
      return <FormNotice tone="error">{t("connectionGive.loadFailed")}</FormNotice>;
    }
    if (!load.connection) {
      return (
        <Banner layout="line" data-connection-give-none="">
          {t("connectionGive.noTools", { connection: connectionTitle })}
        </Banner>
      );
    }
    if (load.agents.length === 0) {
      return (
        <Banner layout="line" data-connection-give-none="">
          {t("connectionGive.noAgents")}
        </Banner>
      );
    }
    return (
      <div data-connection-give-agents="">
        <RadioGroup
          label={t("connectionGive.agentLabel")}
          hint={t("connectionGive.agentHint")}
          options={load.agents.map((agent) => {
            const line = draftLine(agent, host?.viewerId, t) ?? agent.description;
            return {
              value: agent.name,
              label: <span data-connection-give-agent={agent.name}>{agent.title}</span>,
              ...(line === undefined ? {} : { description: line })
            };
          })}
          {...(chosen === undefined ? {} : { value: chosen })}
          onValueChange={setChosen}
          disabled={busy}
        />
      </div>
    );
  }

  function askBody(asked: Extract<GivePlan, { status: "ready" }>): ReactNode {
    const agent = asked.now.title;
    const count = asked.tools.length;
    return (
      <div className="grid min-w-0 gap-3" data-connection-give-ask={asked.agent}>
        <p className="text-label text-foreground">
          {count === 1
            ? t("connectionGive.questionOne", { agent, connection: connectionTitle })
            : t("connectionGive.question", { agent, count, connection: connectionTitle })}
        </p>
        <ul className="grid min-w-0 gap-1 rounded-md border px-3 py-2 text-body text-foreground">
          {asked.tools.map((tool) => (
            <li key={tool.toolName} className="truncate" data-connection-give-tool={tool.toolName}>
              {tool.title}
            </li>
          ))}
        </ul>
        {asked.now.ownDraft ? (
          <>
            <Banner layout="line" data-connection-give-own-draft="">
              {t("connectionGive.ownDraftNotice", { agent })}
            </Banner>
            <Checkbox
              checked={publishDraft}
              onCheckedChange={setPublishDraft}
              disabled={busy}
              label={t("connectionGive.publishDraft")}
              description={t("connectionGive.publishDraftHint")}
              data-connection-give-publish-draft=""
            />
          </>
        ) : (
          <p className="text-body text-muted-foreground">
            {t("connectionGive.publishes", { agent })}
          </p>
        )}
      </div>
    );
  }

  function footer(): ReactNode {
    switch (step.step) {
      case "pick": {
        const offered = ready?.connection !== undefined && (ready?.agents.length ?? 0) > 0;
        return (
          <>
            <Button variant="outline" disabled={busy} onClick={onBack ?? onClose}>
              {t(onBack ? "connectionGive.back" : "connectionGive.cancel")}
            </Button>
            {load.status === "failed" ? (
              <Button variant="outline" onClick={() => setAttempt((count) => count + 1)}>
                {t("connectionGive.retry")}
              </Button>
            ) : offered ? (
              <Button
                loading={busy}
                disabled={chosen === undefined}
                data-connection-give-next=""
                onClick={() => {
                  plan().catch(() => setBusy(false));
                }}
              >
                {t("connectionGive.next")}
              </Button>
            ) : null}
          </>
        );
      }
      case "ask": {
        const asked = step.plan;
        const publishes = !asked.now.ownDraft || publishDraft;
        return (
          <>
            <Button variant="outline" disabled={busy} onClick={back}>
              {t("connectionGive.back")}
            </Button>
            <Button
              loading={busy}
              data-connection-give-confirm=""
              onClick={() => {
                give(asked).catch(() => setBusy(false));
              }}
            >
              {t(publishes ? "connectionGive.confirmPublish" : "connectionGive.confirmDraft")}
            </Button>
          </>
        );
      }
      case "refused":
        return (
          <>
            <Button variant="outline" onClick={back}>
              {t("connectionGive.back")}
            </Button>
            {step.plan.status === "other_draft" || step.plan.status === "stale_draft"
              ? openAgent(step.plan.agent, step.plan.title)
              : null}
          </>
        );
      case "done": {
        const { outcome, agent } = step;
        if (outcome.status === "failed" || outcome.status === "other_draft") {
          return (
            <>
              <Button variant="outline" onClick={back}>
                {t("connectionGive.back")}
              </Button>
              {outcome.status === "other_draft" ? openAgent(agent.name, agent.title) : null}
            </>
          );
        }
        return (
          <Button data-connection-give-done="" onClick={onClose}>
            {t("connectionGive.done")}
          </Button>
        );
      }
    }
  }
}

/** The line under an agent with an unpublished draft: whose it is. */
function draftLine(
  agent: GiveAgent,
  viewerId: string | undefined,
  t: TranslationContextValue["t"]
): string | undefined {
  const { draft } = agent;
  if (!draft) return undefined;
  if (draft.userId === viewerId) return t("connectionGive.ownDraft");
  return draft.authorName === undefined
    ? t("connectionGive.otherDraftShortNoName")
    : t("connectionGive.otherDraftShort", { name: draft.authorName });
}

/** Why nothing was asked. */
function RefusedNotice({
  plan,
  t
}: {
  plan: Exclude<GivePlan, { status: "ready" }>;
  t: TranslationContextValue["t"];
}) {
  switch (plan.status) {
    case "held":
      return (
        <Banner layout="line" tone="success" data-connection-give-held="">
          {t(plan.inDraft ? "connectionGive.heldDraft" : "connectionGive.held", {
            agent: plan.title
          })}
        </Banner>
      );
    case "other_draft":
      return <OtherDraftNotice agent={plan.title} author={plan.author} t={t} />;
    case "stale_draft":
      return (
        <Banner layout="line" tone="warning" data-connection-give-stale-draft="">
          {t("connectionGive.staleDraft", { agent: plan.title })}
        </Banner>
      );
    case "failed":
      return <FormNotice tone="error">{plan.message ?? t("connectionGive.failed")}</FormNotice>;
  }
}

function OtherDraftNotice({
  agent,
  author,
  t
}: {
  agent: string;
  author: string | undefined;
  t: TranslationContextValue["t"];
}) {
  return (
    <Banner layout="line" tone="warning" data-connection-give-other-draft="">
      {author === undefined
        ? t("connectionGive.otherDraftNoName", { agent })
        : t("connectionGive.otherDraft", { agent, author })}
    </Banner>
  );
}

/** What the give did. */
function OutcomeNotice({
  outcome,
  agent,
  connection,
  t
}: {
  outcome: GiveOutcome;
  agent: string;
  connection: string;
  t: TranslationContextValue["t"];
}) {
  switch (outcome.status) {
    case "published":
      return (
        <Banner layout="line" tone="success" data-connection-give-outcome="published">
          {t("connectionGive.published", { agent, connection })}
        </Banner>
      );
    case "drafted":
      return (
        <Banner layout="line" tone="success" data-connection-give-outcome="drafted">
          {t("connectionGive.drafted", { agent })}
        </Banner>
      );
    case "waits":
      return (
        <Banner layout="line" data-connection-give-outcome="waits">
          {t("connectionGive.waits", { agent })}
        </Banner>
      );
    case "other_draft":
      return <OtherDraftNotice agent={agent} author={outcome.author} t={t} />;
    case "failed":
      return (
        <FormNotice tone="error" data-connection-give-outcome="failed">
          {outcome.message ?? t("connectionGive.failed")}
        </FormNotice>
      );
  }
}

/**
 * The done state after "Freigeben": how many tools were approved, and where agents may use
 * them, the one line that gives them to an agent.
 */
export function ConnectionApprovedBody({
  count,
  onGive
}: {
  count: number;
  /** Opens the give. Absent where agents may not use the tools or the place offers no give. */
  onGive?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-4" data-connection-approved="">
      <Banner layout="line" tone="success">
        {count === 1 ? t("connectionGive.approvedOne") : t("connectionGive.approved", { count })}
      </Banner>
      {onGive ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 text-body text-muted-foreground">
            {t("connectionGive.line")}
          </span>
          <Button size="sm" variant="outline" data-connection-give="" onClick={onGive}>
            {t("connectionGive.open")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
