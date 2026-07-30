import type {
  ClientInstanceId,
  ConversationAttachmentId,
  ConversationId,
  StructuredDataResourceId
} from "./ids";
import type { ISODateString } from "./time";

export const STRUCTURED_DATA_RESOURCE_DISPLAY_KIND = "structured_data.resource";

export type StructuredDataFieldSource = {
  attachmentId: ConversationAttachmentId;
  page?: number;
};

export type StructuredDataField = {
  key: string;
  label: string;
  value: string | number | boolean | null;
  sources?: StructuredDataFieldSource[];
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
