import { WORKSPACE_FILE_KINDS } from "@work-shape/catalyst-asset-schemas";
import type { ClientInstanceId, CollaborationWorkspaceId, ConversationId } from "./ids";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";

// What a person finds of the files of a Collaboration Workspace from any of its conversations.
// The platform keeps a Page, an uploaded file and a file an agent made in the conversation
// they came from; a search reads them across the conversations of a workspace that the person
// may read, and answers what they are called and where they live, never what they hold.

/** A Page, a file somebody uploaded, or a file an agent made in an Execution Workspace. */
export const FOUND_FILE_KINDS = WORKSPACE_FILE_KINDS;

export type FoundFileKind = (typeof FOUND_FILE_KINDS)[number];

export interface FoundFile {
  kind: FoundFileKind;
  /** The id of the Page, of the uploaded file, or of the artifact that holds the made file. */
  id: string;
  name: string;
  mimeType?: string;
  /** The size of the newest revision of a Page, of the file otherwise. */
  bytes: number;
  updatedAt: ISODateString;
  /** The conversation it lives in. */
  conversation: { id: ConversationId; title: string };
}

export interface FileSearchStore {
  /**
   * One page of the Pages and files of the conversations of a workspace that `viewerUserId`
   * may read, by the rule of a workspace's conversation list for that viewer, newest first by
   * `updatedAt` and `id`. `text` keeps what has it in its name or in the title of its
   * conversation, whatever the case.
   */
  searchWorkspaceFiles(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    viewerUserId: string;
    kinds: readonly FoundFileKind[];
    text?: string;
    page: StorePage;
  }): Promise<FoundFile[]>;
}
