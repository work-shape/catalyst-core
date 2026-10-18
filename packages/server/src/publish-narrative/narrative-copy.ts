import type {
  LocaleCode,
  PublishNarrativeAudience,
  PublishNarrativeStore,
  PublishNarrativeStoreReaders
} from "@work-shape/catalyst-core";
import type { NotifyChannel, WorkflowTriggerFact } from "./narrative-facts";
import { policyStopWarning } from "./policy-warning-copy";

// The words of the publish question's sentence and warnings, in English and German. Every value
// here is a name or a count the narrator resolved; nothing here reads a row.

/** What a Workflow revision does, with every name as people read it. */
export interface WorkflowSentence {
  title: string;
  triggers: readonly WorkflowTriggerFact[];
  /** The account a run acts as, as people read it. */
  account?: string;
  /** What its reading steps read from: Connections, stores and other reading steps. */
  reads: readonly string[];
  /** The stores its steps only add rows to (`insert`). */
  adds: readonly string[];
  /** The stores its steps may add, change or remove rows in (`load`, or a verb not known). */
  changes: readonly string[];
  /** The stores its steps propose record values for (`records.propose`). */
  proposes: readonly string[];
  /** Its other calls that change something, or whose effect is not known. */
  uses: readonly { through?: string; step: string }[];
  /** Who its `notify` steps reach, one entry for each set of channels, in the order first named. */
  notifies: readonly NoticeRecipientsSentence[];
  children: readonly string[];
  agentSteps: number;
  agentTools: number;
  /** Who reads the stores it writes. Absent where the stored-data module is off. */
  readers?: readonly PublishNarrativeStoreReaders[];
}

/** Who the notices of one set of channels reach, named where the instance knows them. */
export interface NoticeRecipientsSentence {
  channels: readonly NotifyChannel[];
  people: readonly string[];
  /** Recipients named by an id the instance knows no person for: counted, never named. */
  unnamedPeople: number;
  workspaces: readonly string[];
  unnamedWorkspaces: number;
}

/** What an App revision does, with every name as people read it. */
export interface AppSentence {
  audienceLabel?: string;
  title: string;
  /** Who may use it. Absent where the stored-data module is off. */
  audience?: PublishNarrativeAudience;
  /** The workspace that owns it, for when its audience is not counted. */
  workspace?: string;
  stores: readonly PublishNarrativeStore[];
  /** The audience or the stores' sources may be incomplete: one bounded read did not see all. */
  truncated?: boolean;
  readsConnections: readonly string[];
  changes: readonly (
    | { kind: "insert"; store: string }
    | { kind: "connection"; connection: string; action: string }
    | { kind: "workflow"; workflow: string }
  )[];
}

/** A step a guardrail in force will stop when the published revision runs. */
export interface StepStop {
  step: string;
  guardrail: string;
  /** A runtime policy that stops the step without a guardrail. */
  source?: import("@work-shape/catalyst-core").PolicySource;
  outcome: "require_approval" | "block";
  /** The stop depends on a runtime check or input not yet available. */
  checked: boolean;
  /** Its input or policy check failed or did not finish within the narration budget. */
  unavailable?: boolean;
}

/** People and workspaces are named by people: a line break inside one would forge a line. */
export function oneLine(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

/** After "für" and "for", or as the one who is shown or answered. */
type Case = "accusative" | "dative";

/**
 * When a Workflow runs, in words. `opensClause` and `closesClause` say whether the words start
 * or end with a clause of their own ("when someone starts it"): German sets those off by commas.
 */
interface When {
  words: string;
  opensClause: boolean;
  closesClause: boolean;
}

interface Copy {
  quote(name: string): string;
  /** A cron expression in words, or nothing where it is no daily, weekly or monthly form. */
  schedule: {
    daily(time: string): string;
    weekly(day: string, time: string): string;
    monthly(day: number, time: string): string;
    other(cron: string): string;
  };
  /** How a clock time reads in a schedule: "2:00 AM", "02:00". */
  clock: Intl.DateTimeFormatOptions;
  /** These three are clauses of their own. */
  manual: string;
  parent: string;
  noTrigger: string;
  otherTrigger(name: string): string;
  /** The sentence: who runs when, as which account, then everything it does, joined by "and". */
  runs(title: string, when: When, account: string | undefined, doing: readonly string[]): string;
  reads(names: string): string;
  adds(names: string): string;
  changes(names: string): string;
  proposes(names: string): string;
  uses(through: string | undefined, step: string): string;
  notifies(channels: readonly NotifyChannel[], recipients: string): string;
  workspace(name: string): string;
  /** People or workspaces counted beside named ones, or alone. */
  otherPeople(count: number, alone: boolean): string;
  otherWorkspaces(count: number, alone: boolean): string;
  starts(names: string): string;
  agent(steps: number, tools: number): string;
  sendsNothing: string;
  callsNothing: string;
  /**
   * Who the audience is. `incomplete` where a bounded read did not see every grant: an empty
   * count then does not prove that admins alone have access.
   */
  audience(
    audience: PublishNarrativeAudience | undefined,
    grammaticalCase: Case,
    incomplete: boolean
  ): string;
  appShows(app: string, store: string, audience: string): string;
  knowledgeAnswers(base: string, store: string, audience: string): string;
  hiddenReaders(count: number, store: string): string;
  nobodyReads(store: string): string;
  moreReaders(store: string): string;
  appIncomplete: string;
  appOpens(title: string, audience: string): string;
  appOpensAdminsOnly(title: string): string;
  appOpensInWorkspace(title: string, workspace: string): string;
  appStores(stores: string): string;
  storeSource(store: string, fillers: string): string;
  filler(title: string, connections: string): string;
  fillerAlone(title: string): string;
  storeUnavailable(store: string): string;
  appConnections(names: string): string;
  appChanges(changes: string): string;
  appChangesNothing: string;
  insert(store: string): string;
  appUses(connection: string, action: string): string;
  startsWorkflow(workflow: string): string;
  stop(stop: StepStop): string;
}

const EN_N = new Intl.NumberFormat("en");
const DE_N = new Intl.NumberFormat("de");
const EN_AND = new Intl.ListFormat("en", { type: "conjunction" });
const DE_AND = new Intl.ListFormat("de", { type: "conjunction" });

const EN: Copy = {
  quote: (name) => `“${name}”`,
  schedule: {
    daily: (time) => `every day at ${time}`,
    weekly: (day, time) => `every ${day} at ${time}`,
    monthly: (day, time) => `on the ${day}${ordinal(day)} of every month at ${time}`,
    other: (cron) => `on the schedule “${cron}”`
  },
  clock: { hour: "numeric", minute: "2-digit" },
  manual: "when someone starts it",
  parent: "when another Workflow starts it",
  noTrigger: "when it is started",
  otherTrigger: (name) => `on the trigger “${name}”`,
  // The account comes before "when …": after it, it would read as part of that clause.
  runs: (title, when, account, doing) =>
    `${title} ${EN_AND.format([
      `runs${account === undefined ? "" : ` as the account “${account}”`} ${when.words}`,
      ...doing
    ])}.`,
  reads: (names) => `reads from ${names}`,
  adds: (names) => `adds rows to ${names}`,
  changes: (names) => `adds, changes or removes rows in ${names}`,
  proposes: (names) => `proposes record values for ${names}`,
  uses: (through, step) => (through ? `uses ${through} for “${step}”` : `runs “${step}”`),
  notifies: (channels, recipients) =>
    `notifies ${recipients} ${channelWords(channels, "by mail", "in the Inbox", "and")}`,
  workspace: (name) => `the workspace “${name}”`,
  otherPeople: (count, alone) =>
    count === 1
      ? alone
        ? "one person"
        : "one other person"
      : `${EN_N.format(count)} ${alone ? "" : "other "}people`,
  otherWorkspaces: (count, alone) =>
    count === 1
      ? alone
        ? "one workspace"
        : "one other workspace"
      : `${EN_N.format(count)} ${alone ? "" : "other "}workspaces`,
  starts: (names) => `starts ${names}`,
  agent: (steps, tools) =>
    `lets ${steps === 1 ? "an agent" : `${EN_N.format(steps)} agents`} work${tools > 0 ? ` with ${tools === 1 ? "one tool" : `${EN_N.format(tools)} tools`}` : ""}`,
  sendsNothing: "sends nothing",
  callsNothing: "calls nothing outside the Workflow",
  audience: (audience, _case, incomplete) => {
    if (!audience) return "whoever may use it";
    const members =
      audience.workspace && audience.workspace.members > 0
        ? audience.workspace.members === 1
          ? `the one person of “${audience.workspace.title}”`
          : `the ${EN_N.format(audience.workspace.members)} people of “${audience.workspace.title}”`
        : undefined;
    const holders =
      audience.holders === 0
        ? undefined
        : audience.holders === 1
          ? "one holder with its own right"
          : `${EN_N.format(audience.holders)} holders with their own right`;
    if (members && holders) return `${members} and ${holders}`;
    // Instance admins hold every right by their role and are never counted.
    return (
      members ??
      holders ??
      (incomplete ? "instance admins and possibly others" : "instance admins only")
    );
  },
  appShows: (app, store, audience) => `The App “${app}” shows the rows of ${store} to ${audience}.`,
  knowledgeAnswers: (base, store, audience) =>
    `The knowledge base “${base}” answers ${audience} from ${store}.`,
  hiddenReaders: (count, store) =>
    `${count === 1 ? "One more App or knowledge base" : `${EN_N.format(count)} more Apps or knowledge bases`} you may not see read ${store}.`,
  nobodyReads: (store) => `No App or knowledge base reads ${store} yet.`,
  moreReaders: (store) => `This review may omit other readers of ${store}.`,
  appIncomplete: "This review may omit other people or data sources.",
  appOpens: (title, audience) => `${title} opens for ${audience}.`,
  appOpensAdminsOnly: (title) => `${title} opens for instance admins only.`,
  appOpensInWorkspace: (title, workspace) =>
    `${title} opens for whoever may use it in “${workspace}”.`,
  appStores: (stores) => `Everyone who opens it sees what its actions read from ${stores}.`,
  storeSource: (store, fillers) => `${store} (copied by ${fillers})`,
  filler: (title, connections) => `${title} from ${connections}`,
  fillerAlone: (title) => title,
  storeUnavailable: (store) => `${store} (not available)`,
  appConnections: (names) => `It reads ${names} with the rights of whoever opens it.`,
  appChanges: (changes) => `Its actions ${changes}.`,
  appChangesNothing: "It changes nothing.",
  insert: (store) => `add rows to ${store}`,
  appUses: (connection, action) => `use ${connection} for “${action}”`,
  startsWorkflow: (workflow) => `start the Workflow “${workflow}”`,
  stop: ({ step, guardrail, outcome, checked }) =>
    outcome === "block"
      ? checked
        ? `The step “${step}” may be refused: the guardrail “${guardrail}” blocks it when what it checks matches.`
        : `The step “${step}” will be refused: the guardrail “${guardrail}” blocks it.`
      : checked
        ? `The step “${step}” may stop: the guardrail “${guardrail}” asks for approval when what it checks matches, and a published run cannot wait for one.`
        : `The step “${step}” will stop: the guardrail “${guardrail}” asks for approval, and a published run cannot wait for one.`
};

const DE: Copy = {
  quote: (name) => `„${name}“`,
  schedule: {
    daily: (time) => `jeden Tag um ${time} Uhr`,
    weekly: (day, time) => `jeden ${day} um ${time} Uhr`,
    monthly: (day, time) => `am ${day}. jedes Monats um ${time} Uhr`,
    other: (cron) => `nach dem Zeitplan „${cron}“`
  },
  clock: { hour: "2-digit", minute: "2-digit" },
  manual: "wenn jemand ihn startet",
  parent: "wenn ein anderer Workflow ihn startet",
  noTrigger: "wenn er gestartet wird",
  otherTrigger: (name) => `beim Auslöser „${name}“`,
  runs: (title, when, account, doing) => {
    // A "wenn" clause stands between commas: „N“ läuft, wenn jemand ihn startet, unter dem
    // Konto „K“ und liest … The list's own comma after it closes the clause as well.
    const runs = `läuft${when.opensClause ? "," : ""} ${when.words}${account === undefined ? "" : `${when.closesClause ? "," : ""} unter dem Konto „${account}“`}`;
    const closes = when.closesClause && account === undefined && doing.length === 1;
    return `${title} ${DE_AND.format([closes ? `${runs},` : runs, ...doing])}.`;
  },
  reads: (names) => `liest aus ${names}`,
  adds: (names) => `fügt Zeilen in ${names} hinzu`,
  changes: (names) => `fügt Zeilen in ${names} hinzu, ändert oder löscht sie`,
  proposes: (names) => `schlägt Werte für Datensätze in ${names} vor`,
  uses: (through, step) => (through ? `nutzt ${through} für „${step}“` : `führt „${step}“ aus`),
  notifies: (channels, recipients) =>
    `benachrichtigt ${recipients} ${channelWords(channels, "per Mail", "im Eingang", "und")}`,
  workspace: (name) => `den Arbeitsbereich „${name}“`,
  otherPeople: (count, alone) =>
    count === 1
      ? alone
        ? "eine Person"
        : "eine weitere Person"
      : `${DE_N.format(count)} ${alone ? "" : "weitere "}Personen`,
  otherWorkspaces: (count, alone) =>
    count === 1
      ? alone
        ? "einen Arbeitsbereich"
        : "einen weiteren Arbeitsbereich"
      : `${DE_N.format(count)} ${alone ? "" : "weitere "}Arbeitsbereiche`,
  starts: (names) => `startet ${names}`,
  agent: (steps, tools) =>
    `lässt ${steps === 1 ? "einen Agenten" : `${DE_N.format(steps)} Agenten`}${tools > 0 ? ` mit ${tools === 1 ? "einem Werkzeug" : `${DE_N.format(tools)} Werkzeugen`}` : ""} arbeiten`,
  sendsNothing: "sendet nichts",
  callsNothing: "ruft nichts außerhalb des Workflows auf",
  audience: (audience, grammaticalCase, incomplete) => {
    const dative = grammaticalCase === "dative";
    if (!audience)
      return dative ? "allen, die sie verwenden dürfen" : "alle, die sie verwenden dürfen";
    const members =
      audience.workspace && audience.workspace.members > 0
        ? audience.workspace.members === 1
          ? `${dative ? "der einen Person" : "die eine Person"} von „${audience.workspace.title}“`
          : `${dative ? "den" : "die"} ${DE_N.format(audience.workspace.members)} Personen von „${audience.workspace.title}“`
        : undefined;
    // "weitere" only beside the workspace's people: alone, nobody else was named.
    const besides = members !== undefined;
    const holders =
      audience.holders === 0
        ? undefined
        : audience.holders === 1
          ? `${dative ? "einem" : "einen"} ${besides ? "weiteren " : ""}Inhaber mit eigenem Recht`
          : `${DE_N.format(audience.holders)} ${besides ? (dative ? "weiteren " : "weitere ") : ""}${dative ? "Inhabern" : "Inhaber"} mit eigenem Recht`;
    if (members && holders) return `${members} und ${holders}`;
    // Instanz-Admins haben jedes Recht durch ihre Rolle und werden nie gezählt.
    return (
      members ??
      holders ??
      (incomplete
        ? `Instanz-Admins und möglicherweise ${dative ? "weiteren" : "weitere"}`
        : "nur Instanz-Admins")
    );
  },
  appShows: (app, store, audience) => `Die App „${app}“ zeigt ${audience} die Zeilen von ${store}.`,
  knowledgeAnswers: (base, store, audience) =>
    `Die Wissensbasis „${base}“ antwortet ${audience} aus ${store}.`,
  hiddenReaders: (count, store) =>
    `${count === 1 ? "Eine weitere App oder Wissensbasis" : `${DE_N.format(count)} weitere Apps oder Wissensbasen`}, die du nicht sehen darfst, ${count === 1 ? "liest" : "lesen"} ${store}.`,
  nobodyReads: (store) => `Noch keine App und keine Wissensbasis liest ${store}.`,
  moreReaders: (store) => `Diese Übersicht nennt vielleicht nicht alle Leser von ${store}.`,
  appIncomplete: "Diese Übersicht nennt vielleicht nicht alle Personen und Datenquellen.",
  appOpens: (title, audience) => `${title} öffnet sich für ${audience}.`,
  appOpensAdminsOnly: (title) => `${title} öffnet sich nur für Instanz-Admins.`,
  appOpensInWorkspace: (title, workspace) =>
    `${title} öffnet sich für alle, die sie in „${workspace}“ verwenden dürfen.`,
  appStores: (stores) => `Wer sie öffnet, sieht, was ihre Aktionen aus ${stores} lesen.`,
  storeSource: (store, fillers) => `${store} (kopiert von ${fillers})`,
  filler: (title, connections) => `${title} aus ${connections}`,
  fillerAlone: (title) => title,
  storeUnavailable: (store) => `${store} (nicht verfügbar)`,
  appConnections: (names) => `Aus ${names} liest sie mit den Rechten der Person, die sie öffnet.`,
  appChanges: (changes) => `Ihre Aktionen ${changes}.`,
  appChangesNothing: "Sie ändert nichts.",
  insert: (store) => `fügen Zeilen in ${store} hinzu`,
  appUses: (connection, action) => `nutzen ${connection} für „${action}“`,
  startsWorkflow: (workflow) => `starten den Workflow „${workflow}“`,
  stop: ({ step, guardrail, outcome, checked }) =>
    outcome === "block"
      ? checked
        ? `Der Schritt „${step}“ kann abgelehnt werden: Die Leitplanke „${guardrail}“ blockiert ihn, wenn ihre Prüfung einen Treffer ergibt.`
        : `Der Schritt „${step}“ wird abgelehnt: Die Leitplanke „${guardrail}“ blockiert ihn.`
      : checked
        ? `Der Schritt „${step}“ kann angehalten werden: Die Leitplanke „${guardrail}“ verlangt eine Freigabe, wenn ihre Prüfung einen Treffer ergibt, und ein veröffentlichter Lauf kann nicht auf sie warten.`
        : `Der Schritt „${step}“ wird angehalten: Die Leitplanke „${guardrail}“ verlangt eine Freigabe, und ein veröffentlichter Lauf kann nicht auf sie warten.`
};

const COPY: Record<LocaleCode, Copy> = { en: EN, de: DE };

/** Nobody holds its use by a membership or a grant: instance admins alone, by their role. */
function adminsOnly(audience: PublishNarrativeAudience): boolean {
  return (audience.workspace?.members ?? 0) === 0 && audience.holders === 0;
}

/** The channels of a notice in words: "by mail", "in the Inbox", or both. */
function channelWords(
  channels: readonly NotifyChannel[],
  mail: string,
  inbox: string,
  and: string
): string {
  const words = [
    ...(channels.includes("mail") ? [mail] : []),
    ...(channels.includes("inbox") ? [inbox] : [])
  ];
  return words.join(` ${and} `);
}

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  return day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
}

const NUMBER = /^\d{1,2}$/u;

/** A cron expression in words: every day, every week on one day, every month on one day. */
function scheduleWords(cron: string, locale: LocaleCode): string {
  const copy = COPY[locale].schedule;
  const fields = cron.trim().split(/\s+/u);
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;
  const plain =
    fields.length === 5 &&
    NUMBER.test(minute) &&
    NUMBER.test(hour) &&
    month === "*" &&
    Number(minute) <= 59 &&
    Number(hour) <= 23;
  if (!plain) return copy.other(oneLine(cron));
  // A clock time has no day: any day in UTC gives the same words. Some ICU versions put a narrow
  // no-break space before "AM"; the sentence reads the same on every runtime with a plain one.
  const time = new Date(Date.UTC(2026, 0, 1, Number(hour), Number(minute)))
    .toLocaleTimeString(locale, { ...COPY[locale].clock, timeZone: "UTC" })
    .replace(/\u202f/gu, " ");
  if (day === "*" && weekday === "*") return copy.daily(time);
  if (day === "*" && NUMBER.test(weekday) && Number(weekday) <= 7) {
    // 4 January 2026 is a Sunday, which cron counts as 0 and as 7.
    const name = new Date(Date.UTC(2026, 0, 4 + (Number(weekday) % 7))).toLocaleDateString(locale, {
      weekday: "long",
      timeZone: "UTC"
    });
    return copy.weekly(name, time);
  }
  if (weekday === "*" && NUMBER.test(day) && Number(day) >= 1 && Number(day) <= 31) {
    return copy.monthly(Number(day), time);
  }
  return copy.other(oneLine(cron));
}

const lists = (locale: LocaleCode) => ({
  and: new Intl.ListFormat(locale, { type: "conjunction" }),
  or: new Intl.ListFormat(locale, { type: "disjunction" })
});

/** The summary of a Workflow revision. */
export function workflowSummary(input: WorkflowSentence, locale: LocaleCode): string {
  const copy = COPY[locale];
  const { and, or } = lists(locale);
  const quoted = (names: readonly string[]) => and.format(names.map((name) => copy.quote(name)));
  const triggers =
    input.triggers.length === 0
      ? [{ words: copy.noTrigger, clause: true }]
      : input.triggers.map((trigger) =>
          trigger.kind === "schedule"
            ? { words: scheduleWords(trigger.cron, locale), clause: false }
            : trigger.kind === "manual"
              ? { words: copy.manual, clause: true }
              : trigger.kind === "parent"
                ? { words: copy.parent, clause: true }
                : { words: copy.otherTrigger(oneLine(trigger.name)), clause: false }
        );
  const when: When = {
    words: or.format(triggers.map((trigger) => trigger.words)),
    opensClause: triggers[0]?.clause === true,
    closesClause: triggers.at(-1)?.clause === true
  };
  const notices = input.notifies.flatMap((notice) => {
    const named = notice.people.length > 0 || notice.workspaces.length > 0;
    const recipients = [
      ...notice.people,
      ...(notice.unnamedPeople > 0 ? [copy.otherPeople(notice.unnamedPeople, !named)] : []),
      ...notice.workspaces.map((name) => copy.workspace(name)),
      ...(notice.unnamedWorkspaces > 0
        ? [copy.otherWorkspaces(notice.unnamedWorkspaces, !named)]
        : [])
    ];
    return recipients.length > 0 && notice.channels.length > 0
      ? [copy.notifies(notice.channels, and.format(recipients))]
      : [];
  });
  const notifies = notices.length > 0;
  // Only where nothing it calls could send: a child or an agent may, and is said instead.
  const sendsNothing =
    input.uses.length === 0 && !notifies && input.children.length === 0 && input.agentSteps === 0;
  const doing = [
    ...(input.reads.length > 0 ? [copy.reads(and.format(input.reads))] : []),
    ...(input.adds.length > 0 ? [copy.adds(and.format(input.adds))] : []),
    ...(input.changes.length > 0 ? [copy.changes(and.format(input.changes))] : []),
    ...(input.proposes.length > 0 ? [copy.proposes(and.format(input.proposes))] : []),
    ...input.uses.map((use) => copy.uses(use.through, use.step)),
    ...notices,
    ...(input.children.length > 0 ? [copy.starts(quoted(input.children))] : []),
    ...(input.agentSteps > 0 ? [copy.agent(input.agentSteps, input.agentTools)] : [])
  ];
  const sentence = copy.runs(
    input.title,
    when,
    input.account,
    doing.length === 0
      ? [copy.callsNothing]
      : // The list's last item takes the sentence's "and": "runs …, reads … and sends nothing".
        sendsNothing
        ? [...doing, copy.sendsNothing]
        : doing
  );
  const readers = (input.readers ?? []).flatMap((store) => {
    const shown = store.readers.map((reader) =>
      reader.kind === "app"
        ? copy.appShows(
            reader.title,
            store.title,
            copy.audience(reader.audience, "dative", store.truncated)
          )
        : copy.knowledgeAnswers(
            reader.title,
            store.title,
            copy.audience(reader.audience, "dative", store.truncated)
          )
    );
    if (store.hidden > 0) shown.push(copy.hiddenReaders(store.hidden, store.title));
    // A bounded read that did not see every reader never says that nobody reads the store.
    if (store.truncated) shown.push(copy.moreReaders(store.title));
    return shown.length > 0 ? shown : [copy.nobodyReads(store.title)];
  });
  return [sentence, ...readers].join(" ");
}

/** The summary of an App revision. */
export function appSummary(input: AppSentence, locale: LocaleCode): string {
  const copy = COPY[locale];
  const { and } = lists(locale);
  const counted = input.audience;
  const opens = input.audienceLabel
    ? copy.appOpens(input.title, input.audienceLabel)
    : counted === undefined && input.workspace !== undefined
      ? copy.appOpensInWorkspace(input.title, input.workspace)
      : counted !== undefined && adminsOnly(counted) && input.truncated !== true
        ? copy.appOpensAdminsOnly(input.title)
        : copy.appOpens(
            input.title,
            copy.audience(counted, "accusative", input.truncated === true)
          );
  const stores = input.stores.map((store) => {
    if (store.unavailable) return copy.storeUnavailable(store.title);
    const fillers = store.fillers.map((filler) =>
      filler.connections.length > 0
        ? copy.filler(filler.title, and.format(filler.connections))
        : copy.fillerAlone(filler.title)
    );
    return fillers.length > 0 ? copy.storeSource(store.title, and.format(fillers)) : store.title;
  });
  const changes = input.changes.map((change) =>
    change.kind === "insert"
      ? copy.insert(change.store)
      : change.kind === "workflow"
        ? copy.startsWorkflow(change.workflow)
        : copy.appUses(change.connection, change.action)
  );
  return [
    opens,
    ...(stores.length > 0 ? [copy.appStores(and.format(stores))] : []),
    ...(input.readsConnections.length > 0
      ? [copy.appConnections(and.format(input.readsConnections))]
      : []),
    changes.length > 0 ? copy.appChanges(and.format(changes)) : copy.appChangesNothing,
    ...(input.truncated ? [copy.appIncomplete] : [])
  ].join(" ");
}

/** The warnings, one per step and guardrail. */
export function stopWarnings(stops: readonly StepStop[], locale: LocaleCode): string[] {
  return [
    ...new Set(
      stops.map((stop) =>
        stop.unavailable
          ? locale === "de"
            ? `Der Schritt „${stop.step}“ kann angehalten werden: Die Prüfung seiner Eingaben und Richtlinien konnte nicht abgeschlossen werden, daher kann eine Leitplanke oder Richtlinie ihn beim Lauf noch anhalten.`
            : `The step “${stop.step}” may stop: checking its input and policies could not finish, so a guardrail or policy may still stop it when it runs.`
          : stop.source === undefined
            ? COPY[locale].stop(stop)
            : policyStopWarning({ ...stop, source: stop.source }, locale)
      )
    )
  ];
}
