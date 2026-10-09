import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, listAll, type ApiClient, type DraftAttachment } from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { useTranslation, type TranslationContextValue } from "../i18n";
import type { LocalUploadingAttachment } from "../assistant/assistant-composer";

export interface DraftAttachmentControllerInput {
  enabled: boolean;
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  selectedConversationId: string | undefined;
  isAuthenticated: boolean;
  ensureConversationForFiles(files: File[]): Promise<string>;
  /** The last draft attachment of the conversation was removed and no upload is in flight. */
  onDraftAttachmentsEmptied?(conversationId: string): void;
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
const MAX_CONCURRENT_UPLOADS = 2;
const UPLOAD_ATTEMPTS = 3;
const GATEWAY_FAILURE_STATUSES = [0, 502, 503, 504];
// A dropped folder can run into the instance's limit on changing calls. Each file waits as
// long as the API says and goes on, a bounded number of times.
const RATE_LIMIT_WAITS = 5;

export function useDraftAttachmentController(
  input: DraftAttachmentControllerInput
): DraftAttachmentController {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const uploadLimiter = useRef(createConcurrencyLimiter(MAX_CONCURRENT_UPLOADS));
  const [localUploadingAttachments, setLocalUploadingAttachments] = useState<
    LocalUploadingConversationAttachment[]
  >([]);
  // Removal settles after later renders, so it reads the uploads and callback of that moment.
  const latest = useRef({ input, localUploadingAttachments });
  latest.current = { input, localUploadingAttachments };
  const draftAttachmentsQuery = useQuery({
    queryKey: workspaceQueryKeys.draftAttachments(
      input.apiBaseUrl,
      input.authScope,
      input.selectedConversationId
    ),
    queryFn: () =>
      listAll((paging) =>
        input.client.conversations.draft_attachments.list({
          params: { conversationId: input.selectedConversationId ?? "" },
          query: paging
        })
      ),
    enabled: input.enabled && input.isAuthenticated && Boolean(input.selectedConversationId),
    refetchInterval: (query) =>
      hasProcessingDraftAttachments((query.state.data as DraftAttachment[] | undefined) ?? [])
        ? 1000
        : false
  });
  const draftAttachments = input.selectedConversationId ? (draftAttachmentsQuery.data ?? []) : [];
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
        void startUpload(conversationId, file);
      }
    } catch (error) {
      input.onError(error instanceof ApiError ? error.message : "File upload failed");
    }
  }

  async function startUpload(conversationId: string, file: File): Promise<void> {
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
    await uploadLimiter
      .current(() =>
        uploadFileWithRetry(file, (readFile) =>
          input.client.conversations.draft_attachments.upload({
            params: { conversationId },
            file: readFile
          })
        )
      )
      .then((response) => {
        queryClient.setQueryData(
          workspaceQueryKeys.draftAttachments(input.apiBaseUrl, input.authScope, conversationId),
          response.attachments
        );
        void queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.draftAttachments(
            input.apiBaseUrl,
            input.authScope,
            conversationId
          )
        });
        void queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.conversationsScope(input.apiBaseUrl, input.authScope)
        });
      })
      .catch((error) => {
        input.onError(uploadErrorMessage(error, file.name, t));
      })
      .finally(() => {
        setLocalUploadingAttachments((currentAttachments) =>
          currentAttachments.filter((attachment) => attachment.id !== localId)
        );
      });
  }

  function onRemoveDraftAttachment(attachmentId: string) {
    const conversationId = input.selectedConversationId;
    if (!conversationId) {
      return;
    }
    const queryKey = workspaceQueryKeys.draftAttachments(
      input.apiBaseUrl,
      input.authScope,
      conversationId
    );
    void input.client.conversations.draft_attachments
      .delete({ params: { conversationId, attachmentId } })
      .then(() => {
        const remaining = withoutDraftAttachment(
          queryClient.getQueryData<DraftAttachment[]>(queryKey) ?? [],
          attachmentId
        );
        queryClient.setQueryData(queryKey, remaining);
        void queryClient.invalidateQueries({ queryKey });
        // The conversation leaves the rail with its last draft attachment.
        void queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.conversationsScope(input.apiBaseUrl, input.authScope)
        });
        const uploading = latest.current.localUploadingAttachments.some(
          (attachment) => attachment.conversationId === conversationId
        );
        if (remaining.length === 0 && !uploading) {
          latest.current.input.onDraftAttachmentsEmptied?.(conversationId);
        }
      })
      .catch((error) => input.onError(error instanceof ApiError ? error.message : "Remove failed"));
  }

  function onRetryDraftAttachment(attachmentId: string) {
    if (!input.selectedConversationId) {
      return;
    }
    void input.client.conversations.draft_attachments
      .retry({ params: { conversationId: input.selectedConversationId, attachmentId } })
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

export function withoutDraftAttachment<Attachment extends { id: string }>(
  attachments: readonly Attachment[],
  attachmentId: string
): Attachment[] {
  return attachments.filter((attachment) => attachment.id !== attachmentId);
}

class UnreadableFileError extends Error {}

/**
 * Reads the file into memory before the request opens, then retries failures that are not an
 * answer from the API. A browser that cannot read a file promptly (a cloud-synced folder that
 * still has to download it) otherwise opens the request and stalls its body until the reverse
 * proxy gives up. Retrying is safe: the API deduplicates uploads by checksum. An upload the API
 * refused for the rate limit waits the time the API names and is sent again.
 */
export async function uploadFileWithRetry<T>(
  file: File,
  upload: (readFile: File) => Promise<T>,
  retryDelayMs = 1000,
  wait: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new UnreadableFileError(file.name);
  }
  const readFile = new File([bytes], file.name, {
    type: file.type,
    lastModified: file.lastModified
  });
  let rateLimitWaits = 0;
  for (let attempt = 1; ;) {
    try {
      return await upload(readFile);
    } catch (error) {
      const retryAfterSeconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
      if (retryAfterSeconds !== undefined && rateLimitWaits < RATE_LIMIT_WAITS) {
        rateLimitWaits += 1;
        await wait(retryAfterSeconds * 1000);
        continue;
      }
      if (attempt >= UPLOAD_ATTEMPTS || !isTransientUploadError(error)) {
        throw error;
      }
      await wait(attempt * retryDelayMs);
      attempt += 1;
    }
  }
}

function isTransientUploadError(error: unknown): boolean {
  return !(error instanceof ApiError) || GATEWAY_FAILURE_STATUSES.includes(error.status);
}

export function uploadErrorMessage(
  error: unknown,
  filename: string,
  t: TranslationContextValue["t"]
): string {
  if (error instanceof UnreadableFileError) {
    return t("attachmentUploadUnreadable", { filename });
  }
  if (isTransientUploadError(error)) {
    return t("attachmentUploadFailed", { filename });
  }
  return `${filename}: ${(error as ApiError).message}`;
}

function createConcurrencyLimiter(maxConcurrency: number) {
  let activeCount = 0;
  const pending: Array<() => void> = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (activeCount >= maxConcurrency) {
      await new Promise<void>((resolve) => pending.push(resolve));
    }
    activeCount += 1;
    try {
      return await task();
    } finally {
      activeCount -= 1;
      pending.shift()?.();
    }
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
  if (
    draftAttachments.some(
      (attachment) => attachment.status === "queued" || attachment.status === "preprocessing"
    )
  ) {
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
