import type { ClientInstanceId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

// The working state a capability keeps of its own process, such as a form's draft (ADR-0033).
// The platform keeps the one table; a capability reaches only its own rows, through the port
// `records` of its context. A business record never lives here: it goes into a Data Store.

/** One record of one capability. `kind` and `id` name it within the capability. */
export interface CapabilityRecord {
  capability: string;
  kind: string;
  id: string;
  /**
   * A second name the capability looks the record up by, such as the hash of a link token.
   * Unique within the capability and kind.
   */
  key?: string;
  /** The capability's own word for where the record stands. */
  status: string;
  document: JsonObject;
  /** Counts the writes of the record, so a write can be made against the one it read. */
  version: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  /** After this moment the record is the capability's to delete; nothing else reads it. */
  expiresAt?: ISODateString;
}

interface CapabilityRecordName {
  clientInstanceId: ClientInstanceId;
  capability: string;
  kind: string;
}

export interface CapabilityRecordStore {
  /** Writes a new record. `undefined` when its id or its key is taken. */
  create(
    input: CapabilityRecordName & {
      id: string;
      key?: string;
      status: string;
      document: JsonObject;
      expiresAt?: ISODateString;
      at: ISODateString;
    }
  ): Promise<CapabilityRecord | undefined>;
  get(input: CapabilityRecordName & { id: string }): Promise<CapabilityRecord | undefined>;
  getByKey(input: CapabilityRecordName & { key: string }): Promise<CapabilityRecord | undefined>;
  /**
   * Changes a record, as one write. With `version` only the record as the caller read it is
   * changed. `undefined` when there is none, or it changed since.
   */
  update(
    input: CapabilityRecordName & {
      id: string;
      version?: number;
      status?: string;
      document?: JsonObject;
      expiresAt?: ISODateString | null;
      at: ISODateString;
    }
  ): Promise<CapabilityRecord | undefined>;
  /**
   * Moves up to `limit` records of one status to another, in one statement, and answers them as
   * they were before. Of two processes that claim at once, each gets other records. With
   * `expiresBefore`, only records that expire before that moment.
   */
  claim(
    input: CapabilityRecordName & {
      status: string;
      toStatus: string;
      limit: number;
      expiresBefore?: ISODateString;
      at: ISODateString;
    }
  ): Promise<CapabilityRecord[]>;
  /** Deletes the capability's records of every kind that expired before `before`. */
  deleteExpired(input: {
    clientInstanceId: ClientInstanceId;
    capability: string;
    before: ISODateString;
  }): Promise<number>;
}
