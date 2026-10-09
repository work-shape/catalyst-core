import { z } from "zod";
import {
  artifactPreviewResponseSchema,
  draftAttachmentSchema,
  draftAttachmentUploadResponseSchema
} from "../conversations";
import { blob, defineOperation, json } from "./define-operation";

export const conversationFileOperations = {
  listDraftAttachments: defineOperation({
    id: "listDraftAttachments",
    method: "GET",
    path: "/api/conversations/:conversationId/draft-attachments",
    summary: "List the attachments of the unsent message",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    response: json(z.array(draftAttachmentSchema)),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  uploadDraftAttachment: defineOperation({
    id: "uploadDraftAttachment",
    method: "POST",
    path: "/api/conversations/:conversationId/draft-attachments",
    summary: "Upload an attachment for the next message",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:write",
    requires: [],
    effect: "changing",
    multipart: true,
    response: json(draftAttachmentUploadResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  }),
  retryDraftAttachment: defineOperation({
    id: "retryDraftAttachment",
    method: "POST",
    path: "/api/conversations/:conversationId/draft-attachments/:attachmentId/retry",
    summary: "Process a failed draft attachment again",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:write",
    requires: [],
    effect: "changing",
    response: json(draftAttachmentUploadResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  }),
  deleteDraftAttachment: defineOperation({
    id: "deleteDraftAttachment",
    method: "DELETE",
    path: "/api/conversations/:conversationId/draft-attachments/:attachmentId",
    summary: "Remove a draft attachment",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:write",
    requires: [],
    effect: "changing",
    response: json(draftAttachmentSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  }),
  getConversationFileContent: defineOperation({
    id: "getConversationFileContent",
    method: "GET",
    path: "/api/conversations/:conversationId/files/:fileId/content",
    summary: "Download or display a file of a conversation",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    query: z.object({ download: z.string().optional() }),
    response: blob(),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  getConversationArtifactContent: defineOperation({
    id: "getConversationArtifactContent",
    method: "GET",
    path: "/api/conversations/:conversationId/artifacts/:artifactId/content",
    summary: "Download or display an artifact of a conversation",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    query: z.object({ inline: z.string().optional() }),
    response: blob(),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  getConversationArtifactPreview: defineOperation({
    id: "getConversationArtifactPreview",
    method: "GET",
    path: "/api/conversations/:conversationId/artifacts/:artifactId/preview",
    summary: "Read the page preview of an artifact",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    response: json(artifactPreviewResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  getConversationAttachmentPreview: defineOperation({
    id: "getConversationAttachmentPreview",
    method: "GET",
    path: "/api/conversations/:conversationId/attachments/:attachmentId/preview",
    summary: "Read the page preview of a sent attachment",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    response: json(artifactPreviewResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  retryConversationArtifactPreview: defineOperation({
    id: "retryConversationArtifactPreview",
    method: "POST",
    path: "/api/conversations/:conversationId/artifacts/:artifactId/preview/retry",
    summary: "Render a failed artifact preview again",
    tag: "Conversation Files",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "changing",
    response: json(artifactPreviewResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  })
} as const;
