import type { AppAvailability } from "./app-audience";
import { AppError } from "./errors";
import type { JsonObject } from "./json";
import type { LocaleCode } from "./localization";
import type { ActorAccess } from "./permissions";

// The widening check (DS-13c): a stored copy never inherits its source's rights, so the moment a
// copy reaches more people is guarded. At a Workflow publish, an App publish or availability
// change and a Knowledge Base publish, everyone who can read a store's rows must be allowed to
// use each of its sources (`connection.use`). Where the publish would hand a source's data to
// people who may not use the source, a holder of `connection.write` on it confirms the hand-over
// ("Weitergabe"), and the confirmation is audited. Readers are counted and never named.
// Spec: data-stores-and-knowledge-bases.md, Sources, readers and data scope.

/** One asset a publish makes live, with the revision's config it makes live. */
export interface DataHandoverPublish {
  kind: string;
  name: string;
  /** The config of the revision that goes live. */
  config: JsonObject | null;
  /** Of an App: who may use it once published. Absent keeps the live availability. */
  appAvailability?: AppAvailability;
}

/** One source of one store the publish reaches, and who the publish newly hands its data to. */
export interface DataHandoverPair {
  store: {
    name: string;
    /** The title people read, where the caller may see the store; its name otherwise. */
    title: string;
  };
  connection: {
    name: string;
    /** The Connection's name people read; absent where the caller may not see it. */
    title?: string;
  };
  /** The people who read the store's rows once the publish is live. */
  readers: number;
  /** Of them, how many may not use the source after the publish. */
  lacking: number;
  /**
   * Of those, how many this publish hands the data to: they read the store only through it, or
   * the source is new to the store. The confirmation is about them.
   */
  newlyLacking: number;
  /** The caller holds `connection.write` on the source and may confirm the hand-over. */
  mayConfirm: boolean;
}

/** What the widening check answers for one publish. */
export interface DataHandoverAnswer {
  /** Each source of each store the publish reaches that has one. Empty: nothing to say. */
  pairs: readonly DataHandoverPair[];
  /**
   * Where the publish hands data to somebody who may not use its source: what the publish
   * passes as `confirmHandover`. It changes when who that is changes.
   */
  confirmation?: string;
  /** More published assets exist than one bounded read looks through. */
  truncated: boolean;
}

/** The widening check, as the stored-data module answers it. Absent where the module is off. */
export interface DataHandover {
  check(
    access: ActorAccess,
    publishing: readonly DataHandoverPublish[]
  ): Promise<DataHandoverAnswer>;
}

/** The refusals of a publish that hands data on without the confirmation it needs. */
const DATA_HANDOVER_REFUSALS = {
  /** The caller may not confirm the hand-over: they hold no `connection.write` on the source. */
  data_handover_needs_owner: "FORBIDDEN",
  /** The caller may confirm and did not, or confirmed another hand-over than this one. */
  data_handover_unconfirmed: "CONFLICT"
} as const;

export type DataHandoverRefusal = keyof typeof DATA_HANDOVER_REFUSALS;

/** The pairs whose hand-over the publish needs confirmed. */
export function dataHandoverGaps(answer: DataHandoverAnswer): DataHandoverPair[] {
  return answer.pairs.filter((pair) => pair.newlyLacking > 0);
}

/**
 * Refuses a publish that hands data on unconfirmed: where the caller may not confirm, it names
 * who may; where they may, it names the confirmation to pass. Nothing where the check holds or
 * the caller confirmed exactly this hand-over. Never names a person, and names a Connection
 * only where the caller may see it.
 */
export function requireDataHandover(
  answer: DataHandoverAnswer,
  confirmHandover: string | undefined
): void {
  const gaps = dataHandoverGaps(answer);
  const first = gaps[0];
  if (first === undefined) return;
  const source = first.connection.title ? `'${first.connection.title}'` : "one of its sources";
  const facts = {
    dataStore: first.store.name,
    title: first.store.title,
    readers: first.newlyLacking,
    ...(first.connection.title
      ? { connection: first.connection.name, connectionTitle: first.connection.title }
      : {})
  };
  const said = `${first.newlyLacking} ${first.newlyLacking === 1 ? "person" : "people"} who would read the Data Store '${first.store.title}' after this publish may not use ${first.connection.title ? `the Connection ${source}` : source}.`;
  const owner = gaps.find((gap) => !gap.mayConfirm);
  if (owner) {
    throw new AppError(
      DATA_HANDOVER_REFUSALS.data_handover_needs_owner,
      `${said} Only a person who holds connection.write on that Connection may confirm the hand-over: ask them to publish this revision, or narrow who reads the store.`,
      { reason: "data_handover_needs_owner", ...facts },
      { exposeMessage: true }
    );
  }
  if (confirmHandover !== answer.confirmation) {
    throw new AppError(
      DATA_HANDOVER_REFUSALS.data_handover_unconfirmed,
      `${said} Confirm the hand-over with assets.publish confirmHandover: '${answer.confirmation ?? ""}' (CLI: --confirm-handover ${answer.confirmation ?? ""}).`,
      {
        reason: "data_handover_unconfirmed",
        ...facts,
        ...(answer.confirmation ? { confirmation: answer.confirmation } : {})
      },
      { exposeMessage: true }
    );
  }
}

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
  if (answer.pairs.length === 0) return { holds: true, lines: [] };
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
  return {
    holds: false,
    lines: gaps.map((gap) => {
      const one = gap.newlyLacking === 1;
      const store = quote(gap.store.title);
      const source = sourceName(gap);
      const owned =
        gap.connection.title === undefined ? (de ? "die Quelle" : "the source") : source;
      const said = de
        ? `${gap.newlyLacking} ${one ? "Person, die" : "Personen, die"} ${store} danach ${one ? "liest, darf" : "lesen, dürfen"} ${source} nicht nutzen.`
        : `${gap.newlyLacking} ${one ? "person who reads" : "people who read"} ${store} after this publish may not use ${source}.`;
      const next = gap.mayConfirm
        ? de
          ? "Mit Veröffentlichen bestätigst du die Weitergabe."
          : "Publishing confirms the hand-over."
        : de
          ? `Die Weitergabe bestätigt eine Person, die ${owned} verwalten darf, indem sie veröffentlicht.`
          : `A person who may change ${owned} confirms the hand-over by publishing.`;
      return `${said} ${next}`;
    })
  };
}
