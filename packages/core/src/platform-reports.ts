import type { ClientInstanceId } from "./ids";
import { createPlatformId } from "./ids";
import type { ISODateString } from "./time";

// PLATFORM-REPORT: a run or a tool that failed for a platform reason is the platform's problem.
// The conversation offers "Problem an Workshape melden": the person sends the run's id, the
// error code, the instance and the time to the operator's support address, with an optional
// note of their own. The note goes into the mail and nowhere else; the record below keeps who
// reported which run, so one run is reported once per person and a person a few times an hour.

export { PLATFORM_REPORT_NOTE_MAX_LENGTH } from "@work-shape/catalyst-asset-schemas";
/** How many reports one person sends in an hour, whatever the runs. */
export const PLATFORM_REPORTS_PER_HOUR = 5;
/**
 * For how many days a report's record is kept. It holds no text: only who reported which run
 * with which code, for the limits above.
 */
export const PLATFORM_REPORT_RETENTION_DAYS = 90;

export type PlatformReportId = string;

export function createPlatformReportId(): PlatformReportId {
  return createPlatformId("prep");
}

/** Who reported which run with which code. Never the note, never anything of the conversation. */
export interface PlatformReportRecord {
  id: PlatformReportId;
  clientInstanceId: ClientInstanceId;
  /** A reference: the run may be gone with its conversation. */
  agentRunId: string;
  authorUserId: string;
  errorCode: string;
  createdAt: ISODateString;
}

export type CreatePlatformReportResult =
  | { status: "created"; record: PlatformReportRecord }
  /** The author reported this run before. */
  | { status: "duplicate" }
  /** The author sent `perHour` reports in the hour before `createdAt`. */
  | { status: "limited" };

export interface PlatformReportStore {
  /**
   * Records a report unless its author reported the run before or reached `perHour` reports in
   * the hour before `createdAt`. Two calls of one author are decided one after the other.
   */
  createPlatformReport(input: {
    id: PlatformReportId;
    clientInstanceId: ClientInstanceId;
    agentRunId: string;
    authorUserId: string;
    errorCode: string;
    createdAt: ISODateString;
    perHour: number;
  }): Promise<CreatePlatformReportResult>;
  /** Removes a report whose mail did not leave, so its author may send it again. */
  deletePlatformReport(input: {
    clientInstanceId: ClientInstanceId;
    id: PlatformReportId;
  }): Promise<void>;
  /** Removes up to `limit` reports created before `before`. Answers how many it removed. */
  deletePlatformReportsBefore(input: {
    clientInstanceId: ClientInstanceId;
    before: Date;
    limit: number;
  }): Promise<number>;
}
