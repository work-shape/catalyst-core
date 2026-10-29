import type { AppAvailability } from "./app-audience";
import type { ApprovalFurtherRight } from "./approval-requests";
import type { AgentAvailability } from "./config-assets";
import { AppError } from "./errors";
import { isAuthenticatedServicePrincipal, type AuthenticatedIdentity } from "./identity";
import { isJsonObject, type JsonObject, type JsonValue } from "./json";
import type { LocaleCode } from "./localization";
import type { OperationOrigin } from "./operations";
import type { ActorAccess } from "./permissions";

// The widening check (DS-13c): a stored copy never inherits its source's rights, so the moment a
// copy reaches more people, or gains a source, is guarded. At every change that widens who reads
// a store's rows or adds a source to it (a publish of a Workflow, an App, a Knowledge Base or an
// agent, a Knowledge Base's availability, a move of an asset to a wider owner), everyone who
// can read the rows must be allowed to use each of its sources (`connection.use`). A Knowledge
// Base with synced sources is a store of its own: its readers are who may use it. Where the
// change would hand a source's data to people who may not use the source, it waits in the Inbox
// for a person who holds `connection.write` on the source; that person's approval is the
// confirmation ("Weitergabe"). Such a person who makes the change themselves confirms it with
// it. No policy turns the wait off, and the confirmation is audited. Readers are counted and
// never named. Spec: data-stores-and-knowledge-bases.md, Sources, readers and data scope.

/** One asset as a change would leave it: its new config, owner or availability. */
export interface DataHandoverPublish {
  kind: string;
  name: string;
  /** The config of the revision that goes live. Absent keeps the live config. */
  config?: JsonObject | null;
  /** Of an App: who may use it once published. Absent keeps the live availability. */
  appAvailability?: AppAvailability;
  /** Who owns the asset afterwards. Absent keeps its owner. */
  scope?: { kind: "instance" } | { kind: "workspace"; workspaceId: string };
  /** Of a Knowledge Base: the workspaces it is offered in afterwards. */
  availability?: AgentAvailability;
}

/** One source of one store the change reaches, and who the change newly hands its data to. */
export interface DataHandoverPair {
  store: {
    /** `data_store`, or `knowledge_base` for a Knowledge Base with synced sources. */
    kind: string;
    name: string;
    /** The title people read, where the caller may see the store; its name otherwise. */
    title: string;
  };
  connection: {
    name: string;
    assetId: string;
    workspaceId?: string;
    /** The Connection's name people read; absent where the caller may not see it. */
    title?: string;
  };
  /** The people who read the store's rows once the change is made. */
  readers: number;
  /** Of them, how many may not use the source after the change. */
  lacking: number;
  /**
   * Of those, how many this change hands the data to: they read the store only through it, or
   * the source is new to the store. The confirmation is about them.
   */
  newlyLacking: number;
  /** The caller holds `connection.write` on the source and may confirm the hand-over. */
  mayConfirm: boolean;
}

/** What the widening check answers for one change. */
export interface DataHandoverAnswer {
  /** Each source of each store the change reaches that has one. Empty: nothing to say. */
  pairs: readonly DataHandoverPair[];
  /**
   * Where the change needs a confirmation: what a confirming call passes as `confirmHandover`.
   * It changes when who receives which data changes.
   */
  confirmation?: string;
  /**
   * More published assets exist than one bounded read looks through. The check cannot tell
   * then who receives what, so every source it found needs the confirmation, and a store
   * without a known source waits for an approver of operations.
   */
  truncated: boolean;
}

/** The widening check, as the stored-data module answers it. Absent where the module is off. */
export interface DataHandover {
  /** `access` is who the answer is for; without it nothing is shown and nobody may confirm. */
  check(
    access: ActorAccess | undefined,
    changes: readonly DataHandoverPublish[]
  ): Promise<DataHandoverAnswer>;
}

/** The refusals of a change that hands data on without the confirmation it needs. */
const DATA_HANDOVER_REFUSALS = {
  /** The caller may not confirm the hand-over: they hold no `connection.write` on the source. */
  data_handover_needs_owner: "FORBIDDEN",
  /** The caller confirmed another hand-over than this one, or none where it was executed. */
  data_handover_unconfirmed: "CONFLICT",
  /** A key, a service principal, an agent or an embedding host confirmed: only a person does. */
  data_handover_person_only: "FORBIDDEN"
} as const;

export type DataHandoverRefusal = keyof typeof DATA_HANDOVER_REFUSALS;

/** The pairs whose hand-over the change needs confirmed: every pair where the read was cut. */
export function dataHandoverGaps(answer: DataHandoverAnswer): DataHandoverPair[] {
  return answer.truncated
    ? [...answer.pairs]
    : answer.pairs.filter((pair) => pair.newlyLacking > 0);
}

/** Whether the caller may confirm every hand-over of the answer. */
export function dataHandoverMayConfirm(answer: DataHandoverAnswer): boolean {
  const gaps = dataHandoverGaps(answer);
  return gaps.length > 0 && gaps.every((gap) => gap.mayConfirm);
}

/**
 * Whether a call is a person's own click in the interface, the only call that confirms a
 * hand-over: no key, no service principal, no embedding host's token, no agent.
 */
export function confirmsAsPerson(
  actor: AuthenticatedIdentity,
  origin: Pick<OperationOrigin, "kind">
): boolean {
  return (
    origin.kind === "user" &&
    !isAuthenticatedServicePrincipal(actor) &&
    actor.delegatedActor === undefined &&
    actor.keyScopes === undefined
  );
}

/**
 * Refuses a confirmation the caller may not give, or one of another hand-over: where they may
 * not confirm, it names who may; a key or an agent never does. Nothing where the check needs no
 * confirmation or the caller confirmed exactly this hand-over. Never names a person, and names
 * a Connection only where the caller may see it.
 */
export function requireDataHandover(
  answer: DataHandoverAnswer,
  confirmHandover: string | undefined,
  caller: { person: boolean }
): void {
  if (answer.confirmation === undefined) return;
  const gaps = dataHandoverGaps(answer);
  const first = gaps[0];
  const facts = first
    ? {
        // A Knowledge Base is named apart, so the refusal never links it as a Data Store.
        ...(first.store.kind === "data_store"
          ? { dataStore: first.store.name }
          : { knowledgeBase: first.store.name }),
        title: first.store.title,
        readers: first.newlyLacking,
        ...(first.connection.title
          ? { connection: first.connection.name, connectionTitle: first.connection.title }
          : {})
      }
    : { truncated: true };
  const source = first?.connection.title
    ? `the Connection '${first.connection.title}'`
    : "one of its sources";
  const said = first
    ? `${first.newlyLacking} ${first.newlyLacking === 1 ? "person" : "people"} who would read '${first.store.title}' after this change may not use ${source}.`
    : "Not every published asset could be read, so who receives which data cannot be told.";
  if (!caller.person) {
    throw new AppError(
      DATA_HANDOVER_REFUSALS.data_handover_person_only,
      `${said} Only a person signed in to the interface confirms the hand-over: confirm it in the dialog, or make the change without a confirmation and it waits in the Inbox for a person who may change the source.`,
      { reason: "data_handover_person_only", ...facts },
      { exposeMessage: true }
    );
  }
  if (!dataHandoverMayConfirm(answer)) {
    throw new AppError(
      DATA_HANDOVER_REFUSALS.data_handover_needs_owner,
      `${said} Only a person who holds connection.write on that Connection may confirm the hand-over: make the change without a confirmation and it waits in the Inbox for them, or narrow who reads the store.`,
      { reason: "data_handover_needs_owner", ...facts },
      { exposeMessage: true }
    );
  }
  if (confirmHandover !== answer.confirmation) {
    throw new AppError(
      DATA_HANDOVER_REFUSALS.data_handover_unconfirmed,
      `${said} Confirm the hand-over with confirmHandover: '${answer.confirmation}'.`,
      { reason: "data_handover_unconfirmed", ...facts, confirmation: answer.confirmation },
      { exposeMessage: true }
    );
  }
}

/** The key of a held call's subject that names the hand-over its approval confirms. */
const HANDOVER_SUBJECT_KEY = "handover";

/**
 * What a held call's subject keeps of the hand-over its approval confirms: the confirmation,
 * and each source by id, whose `connection.write` who decides it must hold. No person, and no
 * name beyond what the right is asked on.
 */
export function dataHandoverSubject(answer: DataHandoverAnswer): JsonObject | undefined {
  if (answer.confirmation === undefined) return undefined;
  const connections = new Map(
    dataHandoverGaps(answer).map(({ connection }) => [
      connection.assetId,
      {
        name: connection.name,
        assetId: connection.assetId,
        workspaceId: connection.workspaceId ?? null
      }
    ])
  );
  return {
    [HANDOVER_SUBJECT_KEY]: {
      confirmation: answer.confirmation,
      connections: [...connections.values()]
    }
  };
}

/** The confirmation a held call's subject was filed with, or nothing. */
export function dataHandoverSubjectConfirmation(
  subject: JsonValue | undefined
): string | undefined {
  const handover = isJsonObject(subject) ? subject[HANDOVER_SUBJECT_KEY] : undefined;
  return isJsonObject(handover) && typeof handover.confirmation === "string"
    ? handover.confirmation
    : undefined;
}

/**
 * The rights a held call's hand-over asks of who decides it: `connection.write` on each source.
 * A subject without one asks nothing; one that cannot be read throws, and nobody decides it.
 */
export function dataHandoverRights(subject: JsonValue | undefined): ApprovalFurtherRight[] {
  const handover = isJsonObject(subject) ? subject[HANDOVER_SUBJECT_KEY] : undefined;
  if (handover === undefined) return [];
  const connections = isJsonObject(handover) ? handover.connections : undefined;
  if (!Array.isArray(connections)) throw undecidableHandover();
  return connections.map((connection) => {
    if (
      !isJsonObject(connection) ||
      typeof connection.name !== "string" ||
      typeof connection.assetId !== "string"
    )
      throw undecidableHandover();
    return {
      permission: "connection.write",
      resource: {
        kind: "connection",
        name: connection.name,
        assetId: connection.assetId,
        ...(typeof connection.workspaceId === "string"
          ? { workspaceId: connection.workspaceId }
          : {})
      }
    };
  });
}

const undecidableHandover = () =>
  new AppError(
    "CONFLICT",
    "This request does not say which sources it hands on, so nobody can decide it",
    { reason: "handover_subject_unreadable" },
    { exposeMessage: true }
  );

/** A list of names in the reader's language: "A, B and C". */
function listed(names: readonly string[], locale: LocaleCode): string {
  const and = locale === "de" ? "und" : "and";
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1) ?? ""}`;
}

/**
 * The lines the publish question says of the check, in the reader's language: one line where it
 * holds, one per source it hands on where it fails, each with what happens next. Nothing where
 * the publish reaches no store with a source.
 */
export function dataHandoverLines(
  answer: DataHandoverAnswer,
  locale: LocaleCode
): { holds: boolean; lines: string[] } {
  const de = locale === "de";
  const quote = (name: string) => (de ? `„${name}“` : `“${name}”`);
  const sourceName = (pair: DataHandoverPair) =>
    pair.connection.title === undefined
      ? de
        ? "eine für dich verborgene Quelle"
        : "a source hidden from you"
      : quote(pair.connection.title);
  const cut = answer.truncated
    ? [
        de
          ? "Nicht alle veröffentlichten Assets konnten gelesen werden, deshalb braucht diese Veröffentlichung eine bestätigte Weitergabe."
          : "Not every published asset could be read, so this publish needs a confirmed hand-over."
      ]
    : [];
  if (answer.pairs.length === 0) {
    return answer.confirmation === undefined
      ? { holds: true, lines: [] }
      : {
          holds: false,
          lines: [
            ...cut,
            de
              ? "Die Veröffentlichung wartet im Eingang auf eine Freigabe."
              : "The publish waits in the Inbox for an approval."
          ]
        };
  }
  const gaps = dataHandoverGaps(answer);
  if (gaps.length === 0) {
    const stores = listed(
      [...new Set(answer.pairs.map((pair) => quote(pair.store.title)))],
      locale
    );
    const sources = listed([...new Set(answer.pairs.map(sourceName))], locale);
    const everyone = answer.pairs.every((pair) => pair.lacking === 0);
    return {
      holds: true,
      lines: [
        everyone
          ? de
            ? `Alle, die ${stores} lesen, dürfen ${sources} nutzen.`
            : `Everyone who reads ${stores} may use ${sources}.`
          : de
            ? `Diese Veröffentlichung gibt Daten aus ${sources} an niemanden neu weiter, der sie nicht nutzen darf.`
            : `This publish hands data from ${sources} to nobody new who may not use it.`
      ]
    };
  }
  const mayConfirm = dataHandoverMayConfirm(answer);
  return {
    holds: false,
    lines: [
      ...cut,
      ...gaps.map((gap) => {
        const one = gap.newlyLacking === 1;
        const store = quote(gap.store.title);
        const source = sourceName(gap);
        const owned =
          gap.connection.title === undefined ? (de ? "die Quelle" : "the source") : source;
        const said =
          gap.newlyLacking === 0
            ? de
              ? `Wer ${store} danach liest, darf ${source} vielleicht nicht nutzen.`
              : `Who reads ${store} after this publish may not be allowed to use ${source}.`
            : de
              ? `${gap.newlyLacking} ${one ? "Person, die" : "Personen, die"} ${store} danach ${one ? "liest, darf" : "lesen, dürfen"} ${source} nicht nutzen.`
              : `${gap.newlyLacking} ${one ? "person who reads" : "people who read"} ${store} after this publish may not use ${source}.`;
        const next = mayConfirm
          ? de
            ? "Mit Veröffentlichen bestätigst du die Weitergabe."
            : "Publishing confirms the hand-over."
          : de
            ? `Die Veröffentlichung wartet im Eingang, bis eine Person, die ${owned} verwalten darf, die Weitergabe freigibt.`
            : `The publish waits in the Inbox until a person who may change ${owned} approves the hand-over.`;
        return `${said} ${next}`;
      })
    ]
  };
}
