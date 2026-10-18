import type { LocaleCode, NOTIFY_CHANNELS, WorkflowManifest } from "@work-shape/catalyst-core";
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

type LimitRaise = ReturnType<typeof workflowLimitRaises>[number];
type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

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
    mailCountsOnly: "A mail carries counts and a link only."
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
    mailCountsOnly: "Eine E-Mail enthält nur Anzahlen und einen Link."
  }
};

/**
 * The lines of the publish question for one Workflow definition, in `locale`. One read per
 * person and per Shared Workspace the notify steps name; a step names at most 100 of each.
 */
export async function workflowPublishQuestion(input: {
  manifest: WorkflowManifest;
  limits: WorkflowLimitContext;
  locale: LocaleCode;
  names: AddresseeNames;
}): Promise<string[]> {
  const notifySteps = [...indexWorkflowSteps(input.manifest).values()].flatMap(({ step }) =>
    step.type === "notify" ? [step] : []
  );
  const names = await namesOf(input.names, notifySteps);
  const copy = COPY[input.locale];
  const list = new Intl.ListFormat(input.locale, { type: "conjunction" });
  return [
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
