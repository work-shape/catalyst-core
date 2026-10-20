import { APP_MODES, type ConversationSubject, type JsonObject } from "@work-shape/catalyst-core";
import { z } from "zod";
import { PLATFORM_ASSET_TOOLS } from "./names";

// The shapes the asset tools share: what a read, a check and a save answer, and the inputs that
// name an asset.

/** One thing a save of a definition is refused for. `path` is dotted, empty for the whole. */
export interface PlatformAssetIssue {
  path: string;
  message: string;
  code?: string;
}

/** Something a check names that refuses nothing, such as a run key without a rules revision. */
export interface PlatformAssetWarning {
  code: string;
  message: string;
}

/** The asset of a conversation as its agent reads it. */
export interface PlatformAssetRead {
  kind: string;
  name: string;
  config: JsonObject;
  /** The revision `config` is. A save names it as `expectedRevision`. */
  revision: number;
  /** The revision that runs. Missing while nothing is published. */
  publishedRevision?: number;
  draftRevision?: number | null;
  /** Which of the two `config` is: the draft, or the published revision where no draft differs. */
  shows: (typeof APP_MODES)[number];
  /** The workspace that owns the asset, by its id. Missing for an asset of the instance. */
  workspaceId?: string;
  /** Saving this asset files a request and changes nothing until an approver decides. */
  saveApproval?: { approverNames: string[] };
}

/** The asset an agent opened: what it read, and the name people read for the asset. */
export interface PlatformAssetOpened extends PlatformAssetRead {
  title: string;
  /**
   * The asset belongs to the whole instance, and only a person's step makes such an asset the
   * subject: the person was offered to go to it, and the conversation is about it once they do.
   */
  awaitsPerson?: true;
}

/** A file of an asset written as files, such as a Data Store: its path and its text. */
export interface PlatformAssetFile {
  path: string;
  text: string;
}

/**
 * The asset a save without a revision created: the subject where the conversation was about
 * none, else a draft beside the subject (`besideSubject`), which moves nobody.
 */
interface PlatformAssetCreated {
  created: true;
  kind: string;
  name: string;
  title: string;
  /** The workspace that owns it, by its id: the conversation's. Missing for the instance's. */
  workspaceId?: string;
  /** The conversation stays about its subject, and the person stays where they are. */
  besideSubject?: true;
}

interface DraftConflictDetails {
  reason: "draft_changed";
  currentDraftRevision: number | null;
  author?: { userId?: string; conversationId?: string; release: boolean };
  changedAt?: string;
}

export const draftConflictDetailsSchema = z.object({
  reason: z.literal("draft_changed"),
  currentDraftRevision: z.number().int().positive().nullable(),
  author: z
    .object({
      userId: z.string().optional(),
      conversationId: z.string().optional(),
      release: z.boolean()
    })
    .optional(),
  changedAt: z.string().optional()
});

export type PlatformAssetWrite =
  | ({ saved: true; revision: number; draftRevision?: number; publishedRevision?: number } & (
      PlatformAssetCreated | { created?: undefined }
    ))
  | { saved: false; issues: PlatformAssetIssue[] }
  | {
      saved: false;
      conflict: "REVISION_CONFLICT";
      message: string;
      details?: DraftConflictDetails;
    };

export const issueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional()
});
export const configSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "The whole config as the read answered it under 'config', with your changes: every field it had, in the shape it had. What a config holds is decided by the kind of the asset, not by this tool."
  );
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const readOutputSchema = z.object({
  saveApproval: z.object({ approverNames: z.array(z.string()) }).optional(),
  kind: z.string(),
  name: z.string(),
  config: jsonObjectSchema,
  revision: z.number().int(),
  publishedRevision: z.number().int().optional(),
  draftRevision: z.number().int().nullable().optional(),
  shows: z.enum(APP_MODES),
  workspaceId: z.string().optional()
});

export const BOUND = `Without 'kind' and 'name' it works on the asset this conversation is about: open the asset with ${PLATFORM_ASSET_TOOLS.open.name} first, which makes it the one the conversation is about. With them it works on a draft this conversation created beside that asset, and on no other asset.`;

export const kindSchema = z
  .string()
  .min(1)
  .describe(
    "The kind of the asset, as the instance names it: workflow, app or agent, among others."
  );
export const nameSchema = z
  .string()
  .min(1)
  .describe("The name of the asset, its id within its kind.");

/** The draft a check names by kind and name, or nothing where it names no whole one. */
export function createdDraftOf(input: {
  kind?: string;
  name?: string;
}): ConversationSubject | undefined {
  return input.kind !== undefined && input.name !== undefined
    ? { kind: input.kind, name: input.name }
    : undefined;
}
