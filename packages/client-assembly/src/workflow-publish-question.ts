import type {
  LocaleCode,
  NOTIFY_CHANNELS,
  WorkflowManifest,
  WorkflowNeededRight
} from "@work-shape/catalyst-core";
import type { AddresseeNames } from "@work-shape/catalyst-server";
import {
  indexWorkflowSteps,
  workflowDurationText,
  workflowLimitRaises,
  type WorkflowLimitContext
} from "@work-shape/catalyst-workflows";

// The publish question of a Workflow: what making the revision live does beyond its steps, in
// the reader's language. People and Shared Workspaces a notify step reaches are named by their
// names, never by their ids. Mail carries counts and a link only, and the question says so.
// A definition without `runAs` runs as its own account (LIVE-1): the question names it once,
// with what its steps let it do, by the names of the assets and never by ids.

type LimitRaise = ReturnType<typeof workflowLimitRaises>[number];
type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** What the own account may do with an asset, as the question words it. */
type AccountDoes = "use" | "read" | "ingest" | "addRows" | "changeRows" | "start";

/** By the right a step needs; any other right is worded as using the asset. */
const ACCOUNT_DOES: ReadonlyMap<string, AccountDoes> = new Map([
  ["connection.use", "use"],
  ["knowledge_base.use", "use"],
  ["knowledge_base.read", "read"],
  ["knowledge_base.ingest", "ingest"],
  ["data_store.insert", "addRows"],
  ["data_store.execute", "changeRows"],
  ["workflow.use", "start"]
]);

interface QuestionCopy {
  limits: Record<LimitRaise["field"], string>;
  raise(limit: string, from: string, to: string): string;
  notifies(step: string, whom: string, channels: string): string;
  workspace(name: string): string;
  channels: Record<NotifyChannel, string>;
  /** Stands for an id that names no user or no Shared Workspace of the instance any more. */
  unknownPerson: string;
  unknownWorkspace: string;
  mailCountsOnly: string;
  ownAccount(workflow: string): string;
  ownAccountMay(workflow: string, does: string): string;
  accountDoes: Record<AccountDoes, (assets: string) => string>;
  workflowName(name: string): string;
}

const COPY: Record<LocaleCode, QuestionCopy> = {
  en: {
    limits: {
      duration: "run time",
      stepRuns: "step runs",
      loopItems: "items per loop",
      concurrency: "steps at once",
      datasetBytes: "dataset size in bytes",
      pagedStepMinutes: "minutes of a paged step"
    },
    raise: (limit, from, to) => `Raises the ${limit} of each run from ${from} to ${to}.`,
    notifies: (step, whom, channels) => `“${step}” notifies ${whom}, ${channels}.`,
    workspace: (name) => `the workspace “${name}”`,
    channels: { inbox: "in the Inbox", mail: "by mail" },
    unknownPerson: "a person who no longer exists",
    unknownWorkspace: "a workspace that no longer exists",
    mailCountsOnly: "A mail carries counts and a link only.",
    ownAccount: (workflow) => `Runs as its own account “${workflow}”.`,
    ownAccountMay: (workflow, does) => `Runs as its own account “${workflow}” and may ${does}.`,
    accountDoes: {
      use: (assets) => `use ${assets}`,
      read: (assets) => `read ${assets}`,
      ingest: (assets) => `put documents into ${assets}`,
      addRows: (assets) => `add rows to ${assets}`,
      changeRows: (assets) => `change and delete rows in ${assets}`,
      start: (assets) => `start ${assets}`
    },
    workflowName: (name) => `the workflow “${name}”`
  },
  de: {
    limits: {
      duration: "Laufzeit",
      stepRuns: "Schrittläufe",
      loopItems: "Einträge je Schleife",
      concurrency: "gleichzeitigen Schritte",
      datasetBytes: "Datensatzgröße in Bytes",
      pagedStepMinutes: "Minuten eines seitenweisen Schritts"
    },
    raise: (limit, from, to) => `Erhöht die ${limit} jedes Laufs von ${from} auf ${to}.`,
    notifies: (step, whom, channels) => `„${step}“ benachrichtigt ${whom}, ${channels}.`,
    workspace: (name) => `den Arbeitsbereich „${name}“`,
    channels: { inbox: "im Eingang", mail: "per E-Mail" },
    unknownPerson: "eine Person, die es nicht mehr gibt",
    unknownWorkspace: "einen Arbeitsbereich, den es nicht mehr gibt",
    mailCountsOnly: "Eine E-Mail enthält nur Anzahlen und einen Link.",
    ownAccount: (workflow) => `Läuft unter einem eigenen Konto „${workflow}“.`,
    ownAccountMay: (workflow, does) =>
      `Läuft unter einem eigenen Konto „${workflow}“ und darf ${does}.`,
    accountDoes: {
      use: (assets) => `${assets} nutzen`,
      read: (assets) => `${assets} lesen`,
      ingest: (assets) => `Dokumente in ${assets} einspielen`,
      addRows: (assets) => `Datensätze zu ${assets} hinzufügen`,
      changeRows: (assets) => `Datensätze in ${assets} ändern und löschen`,
      start: (assets) => `${assets} starten`
    },
    workflowName: (name) => `den Workflow „${name}“`
  }
};

/**
 * The lines of the publish question for one Workflow definition, in `locale`. One read per
 * person and per Shared Workspace the notify steps name; a step names at most 100 of each.
 * `rights` are the rights the definition's steps need (`workflowNeededRights`); they are read
 * only for a definition without `runAs`, whose own account gets exactly those.
 */
export async function workflowPublishQuestion(input: {
  manifest: WorkflowManifest;
  limits: WorkflowLimitContext;
  locale: LocaleCode;
  names: AddresseeNames;
  rights?: readonly WorkflowNeededRight[];
}): Promise<string[]> {
  const notifySteps = [...indexWorkflowSteps(input.manifest).values()].flatMap(({ step }) =>
    step.type === "notify" ? [step] : []
  );
  const names = await namesOf(input.names, notifySteps);
  const copy = COPY[input.locale];
  const list = new Intl.ListFormat(input.locale, { type: "conjunction" });
  return [
    ...(input.manifest.runAs === undefined
      ? [await ownAccountLine(input.manifest.name, input.rights ?? [], input.names, copy, list)]
      : []),
    ...workflowLimitRaises(input.manifest, input.limits).map((raise) => {
      const show = (value: number) =>
        raise.field === "duration"
          ? workflowDurationText(value)
          : value.toLocaleString(input.locale);
      return copy.raise(
        copy.limits[raise.field],
        show(raise.standard),
        raise.text ?? show(raise.asked)
      );
    }),
    ...notifySteps.map((step) => {
      const whom = list.format([
        ...(step.to.users ?? []).map((id) => oneLine(names.users.get(id) ?? copy.unknownPerson)),
        ...(step.to.workspaces ?? []).map((id) => {
          const name = names.workspaces.get(id);
          return name === undefined ? copy.unknownWorkspace : copy.workspace(oneLine(name));
        })
      ]);
      const channels = list.format(step.channels.map((channel) => copy.channels[channel]));
      const line = copy.notifies(oneLine(step.name), whom, channels);
      return step.channels.includes("mail") ? `${line} ${copy.mailCountsOnly}` : line;
    })
  ];
}

/**
 * The one line on the Workflow's own account: its name and what its steps let it do. Each asset
 * is named by the title the reader may be told, else by its name in the definition. One read
 * per asset, one after the other.
 */
async function ownAccountLine(
  workflow: string,
  rights: readonly WorkflowNeededRight[],
  names: AddresseeNames,
  copy: QuestionCopy,
  list: Intl.ListFormat
): Promise<string> {
  const titles = new Map<string, string>();
  const assets = new Map<AccountDoes, Set<string>>();
  for (const right of rights) {
    const does = ACCOUNT_DOES.get(right.action) ?? "use";
    const key = `${right.asset.kind}:${right.asset.name}`;
    const title =
      titles.get(key) ??
      (await names.asset?.(right.asset.kind, right.asset.name)) ??
      right.asset.name;
    titles.set(key, title);
    const name = oneLine(title);
    const named = does === "start" ? copy.workflowName(name) : name;
    assets.set(does, (assets.get(does) ?? new Set()).add(named));
  }
  const does = [...assets].map(([key, names]) => copy.accountDoes[key](list.format(names)));
  const name = oneLine(workflow);
  return does.length === 0 ? copy.ownAccount(name) : copy.ownAccountMay(name, list.format(does));
}

async function namesOf(
  names: AddresseeNames,
  steps: readonly { to: { users?: readonly string[]; workspaces?: readonly string[] } }[]
): Promise<{ users: ReadonlyMap<string, string>; workspaces: ReadonlyMap<string, string> }> {
  // One after the other: a step may name 100 of each, and the read holds no pool burst.
  const users = new Map<string, string>();
  for (const id of new Set(steps.flatMap((step) => step.to.users ?? []))) {
    const name = await names.user(id);
    if (name !== undefined) users.set(id, name);
  }
  const workspaces = new Map<string, string>();
  for (const id of new Set(steps.flatMap((step) => step.to.workspaces ?? []))) {
    const name = await names.workspace(id);
    if (name !== undefined) workspaces.set(id, name);
  }
  return { users, workspaces };
}

/**
 * Names and step names are written by people, and the CLI prints the lines as they are: a line
 * break or control character inside one would forge further lines, so it becomes one line.
 */
function oneLine(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, " ").trim();
}
