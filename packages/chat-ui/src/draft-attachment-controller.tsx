import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type ApiClient,
  type DraftAttachment
} from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "./api/workspace-query-keys";
import type { LocalUploadingAttachment } from "./assistant-composer";

export interface DraftAttachmentControllerInput {
  enabled: boolean;
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  selectedConversationId: string | undefined;
  isAuthenticated: boolean;
  ensureConversationForFiles(files: File[]): Promise<string>;
  onError(message: string): void;
}

export interface DraftAttachmentController {
  draftAttachments: DraftAttachment[];
  visibleUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  onFilesSelected(files: File[]): void;
  onRemoveDraftAttachment(attachmentId: string): void;
  onRetryDraftAttachment(attachmentId: string): void;
  clearConversationUploads(conversationId: string): void;
}

type LocalUploadingConversationAttachment = LocalUploadingAttachment & { conversationId: string };

export function useDraftAttachmentController(
  input: DraftAttachmentControllerInput
): DraftAttachmentController {
  const queryClient = useQueryClient();
  const [localUploadingAttachments, setLocalUploadingAttachments] = useState<
    LocalUploadingConversationAttachment[]
  >([]);
  const draftAttachmentsQuery = useQuery({
    queryKey: workspaceQueryKeys.draftAttachments(
      input.apiBaseUrl,
      input.authScope,
      input.selectedConversationId
    ),
    queryFn: () => input.client.draftAttachments(input.selectedConversationId ?? ""),
    enabled: input.enabled && input.isAuthenticated && Boolean(input.selectedConversationId),
    refetchInterval: (query) =>
      hasProcessingDraftAttachments((query.state.data as DraftAttachment[] | undefined) ?? [])
        ? 1000
        : false
  });
  const draftAttachments = input.selectedConversationId ? draftAttachmentsQuery.data ?? [] : [];
  const visibleUploadingAttachments = input.selectedConversationId
    ? localUploadingAttachments.filter(
        (attachment) => attachment.conversationId === input.selectedConversationId
      )
    : [];

  function onFilesSelected(files: File[]) {
    if (!input.enabled) {
      return;
    }
    void uploadFiles(files);
  }

  async function uploadFiles(files: File[]): Promise<void> {
    const selectedFiles = files.filter((file) => file.size > 0);
    if (selectedFiles.length === 0) {
      return;
    }
    try {
      const conversationId = await input.ensureConversationForFiles(selectedFiles);
      const acceptedFiles = selectedFiles.filter((file) =>
        shouldUploadFile(file, draftAttachments, localUploadingAttachments)
      );
      for (const file of acceptedFiles) {
        startUpload(conversationId, file);
      }
    } catch (error) {
      input.onError(error instanceof ApiError ? error.message : "File upload failed");
    }
  }

  function startUpload(conversationId: string, file: File) {
    const localId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${file.name}`;
    const localAttachment: LocalUploadingConversationAttachment = {
      id: localId,
      conversationId,
      filename: file.name,
      byteSize: file.size,
      mimeType: file.type || undefined,
      status: "uploading"
    };
    setLocalUploadingAttachments((currentAttachments) => [...currentAttachments, localAttachment]);
    void input.client
      .uploadDraftAttachment(conversationId, file)
      .then((response) => {
        queryClient.setQueryData(
          workspaceQueryKeys.draftAttachments(input.apiBaseUrl, input.authScope, conversationId),
          response.attachments
        );
        void queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.draftAttachments(input.apiBaseUrl, input.authScope, conversationId)
        });
        void queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.conversations(input.apiBaseUrl, input.authScope)
        });
      })
      .catch((error) => {
        input.onError(error instanceof ApiError ? error.message : "File upload failed");
      })
      .finally(() => {
        setLocalUploadingAttachments((currentAttachments) =>
          currentAttachments.filter((attachment) => attachment.id !== localId)
        );
      });
  }

  function onRemoveDraftAttachment(attachmentId: string) {
    if (!input.selectedConversationId) {
      return;
    }
    void input.client
      .deleteDraftAttachment(input.selectedConversationId, attachmentId)
      .then(() => {
        void queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.draftAttachments(
            input.apiBaseUrl,
            input.authScope,
            input.selectedConversationId
          )
        });
      })
      .catch((error) => input.onError(error instanceof ApiError ? error.message : "Remove failed"));
  }

  function onRetryDraftAttachment(attachmentId: string) {
    if (!input.selectedConversationId) {
      return;
    }
    void input.client
      .retryDraftAttachment(input.selectedConversationId, attachmentId)
      .then((response) => {
        queryClient.setQueryData(
          workspaceQueryKeys.draftAttachments(
            input.apiBaseUrl,
            input.authScope,
            input.selectedConversationId
          ),
          response.attachments
        );
      })
      .catch((error) => input.onError(error instanceof ApiError ? error.message : "Retry failed"));
  }

  function clearConversationUploads(conversationId: string) {
    setLocalUploadingAttachments((currentAttachments) =>
      currentAttachments.filter((attachment) => attachment.conversationId !== conversationId)
    );
  }

  return {
    draftAttachments,
    visibleUploadingAttachments,
    sendBlockedReason: getSendBlockedReason(draftAttachments, visibleUploadingAttachments),
    onFilesSelected,
    onRemoveDraftAttachment,
    onRetryDraftAttachment,
    clearConversationUploads
  };
}

function hasProcessingDraftAttachments(attachments: DraftAttachment[]): boolean {
  return attachments.some(
    (attachment) => attachment.status === "queued" || attachment.status === "preprocessing"
  );
}

function getSendBlockedReason(
  draftAttachments: DraftAttachment[],
  localUploadingAttachments: LocalUploadingAttachment[]
): string | undefined {
  if (localUploadingAttachments.length > 0) {
    return "Wait for file upload to finish before sending.";
  }
  if (draftAttachments.some((attachment) => attachment.status === "failed")) {
    return "Remove or retry failed file attachments before sending.";
  }
  if (draftAttachments.some((attachment) => attachment.status === "unsupported")) {
    return "Remove unsupported file attachments before sending.";
  }
  if (draftAttachments.some((attachment) => attachment.status === "queued" || attachment.status === "preprocessing")) {
    return "Wait for file processing to finish before sending.";
  }
  return undefined;
}

function shouldUploadFile(
  file: File,
  draftAttachments: DraftAttachment[],
  localUploadingAttachments: LocalUploadingConversationAttachment[]
): boolean {
  const duplicateExists =
    draftAttachments.some(
      (attachment) => attachment.filename === file.name && attachment.byteSize === file.size
    ) ||
    localUploadingAttachments.some(
      (attachment) => attachment.filename === file.name && attachment.byteSize === file.size
    );
  if (!duplicateExists) {
    return true;
  }
  return window.confirm(`You already uploaded a file named "${file.name}". Upload it again?`);
}
