import type {
  ClientInstanceId,
  ConversationAttachmentId,
  ConversationId,
  StructuredDataResourceId
} from "./ids";
import type { ChatMessage } from "./conversation";
import type { ConversationAttachment } from "./files";
import type { ISODateString } from "./time";

export const STRUCTURED_DATA_RESOURCE_DISPLAY_KIND = "structured_data.resource";

export type StructuredDataFieldSource = {
  attachmentId: ConversationAttachmentId;
  page?: number;
};

export type StructuredDataFieldAttention = {
  reason: "uncertain" | "conflicting";
  message?: string;
};

export type StructuredDataField = {
  key: string;
  label: string;
  value: string | number | boolean | null;
  sources?: StructuredDataFieldSource[];
  attention?: StructuredDataFieldAttention;
};

export type StructuredDataSection = {
  key: string;
  label: string;
  fields: StructuredDataField[];
};

export type StructuredDataState = {
  title: string;
  sections: StructuredDataSection[];
};

export type StructuredDataResourceRecord = {
  id: StructuredDataResourceId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  resourceKey: string;
  title: string;
  state: StructuredDataState;
  revision: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type PublishStructuredDataResourceInput = {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  resourceKey: string;
  title: string;
  state: StructuredDataState;
};

export type StructuredDataPublicationAttachment = Pick<
  ConversationAttachment,
  "id" | "fileId" | "filename"
>;

export type StructuredDataPublicationReviewer = (input: {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  resourceKey: string;
  title: string;
  state: StructuredDataState;
  messages: readonly ChatMessage[];
  attachments: readonly StructuredDataPublicationAttachment[];
}) => readonly string[] | Promise<readonly string[]>;

export interface StructuredDataStore {
  getStructuredDataResource(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    structuredDataResourceId: StructuredDataResourceId;
  }): Promise<StructuredDataResourceRecord | undefined>;
  listStructuredDataResources(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<StructuredDataResourceRecord[]>;
  publishStructuredDataResource(
    input: PublishStructuredDataResourceInput
  ): Promise<StructuredDataResourceRecord>;
}
