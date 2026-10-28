import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  listAll,
  type ApiClient,
  type DraftAttachment
} from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import type { LocalUploadingAttachment } from "../assistant/assistant-composer";

export interface DraftAttachmentControllerInput {
  enabled: boolean;
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  selectedConversationId: string | undefined;
  agentName?: string;
  /** The open workspace; files waiting for a first message belong to it. */
  collaborationWorkspaceId: string | undefined;
  isAuthenticated: boolean;
  /** Makes the conversation the files of a first message go to, without opening it. */
  createConversationForFiles(files: File[]): Promise<CreatedConversation>;
  /** Opens a conversation whose files could not be got ready, so they can be retried there. */
  showConversationForFiles(conversation: CreatedConversation): void;
  /** The last draft attachment of the conversation was removed and no upload is in flight. */
  onDraftAttachmentsEmptied?(conversationId: string): void;
  onError(message: string): void;
}

interface CreatedConversation {
  id: string;
  collaborationWorkspaceId: string;
}

export interface DraftAttachmentController {
  draftAttachments: DraftAttachment[];
  visibleUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  onFilesSelected(files: File[]): void;
  /**
   * The first message of a new conversation is sent: makes the conversation, uploads the files
   * waiting in the composer and answers once they are ready. Without such files it answers the
   * conversation an earlier send made, until `clearConversationUploads` acknowledges its message,
   * and otherwise nothing.
   */
  sendStagedFiles(): Promise<string | undefined>;
  onRemoveDraftAttachment(attachmentId: string): void;
  onRetryDraftAttachment(attachmentId: string): void;
  clearConversationUploads(conversationId: string): void;
}

type LocalUploadingConversationAttachment = LocalUploadingAttachment & { conversationId: string };
/** `uploadedAs` names the draft attachment a file became on a send that failed for another. */
type StagedFile = LocalUploadingAttachment & { file: File; uploadedAs?: string };
const MAX_CONCURRENT_UPLOADS = 2;
const UPLOAD_ATTEMPTS = 3;
const GATEWAY_FAILURE_STATUSES = [0, 502, 503, 504];
// A dropped folder can run into the instance's limit on changing calls. Each file waits as
// long as the API says and goes on, a bounded number of times.
const RATE_LIMIT_WAITS = 5;
const DRAFT_ATTACHMENT_POLL_MS = 1000;
// A first message waits this long for its files; then their conversation opens with them.
const DRAFT_ATTACHMENT_SETTLE_POLLS = 600;

export function useDraftAttachmentController(
  input: DraftAttachmentControllerInput
): DraftAttachmentController {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const uploadLimiter = useRef(createConcurrencyLimiter(MAX_CONCURRENT_UPLOADS));
  const [localUploadingAttachments, setLocalUploadingAttachments] = useState<
    LocalUploadingConversationAttachment[]
  >([]);
  // Files picked before the first message wait here: a conversation is made only when it is sent.
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  // The conversation a first send made, until its message was submitted: a send that failed,
  // in its files or in its message, goes on in it.
  const stagedConversation = useRef<CreatedConversation | undefined>(undefined);
  const ended = useRef(false);
  useEffect(() => {
    ended.current = false;
    return () => {
      ended.current = true;
    };
  }, []);
  // Waiting files and a failed send's conversation stay in the workspace they were picked in:
  // another workspace starts with an empty composer and makes its own conversation.
  const stagedWorkspace = useRef(input.collaborationWorkspaceId);
  useEffect(() => {
    if (stagedWorkspace.current === input.collaborationWorkspaceId) return;
    stagedWorkspace.current = input.collaborationWorkspaceId;
    stagedConversation.current = undefined;
    setStagedFiles([]);
  }, [input.collaborationWorkspaceId]);
  // The start page is left for a conversation: a later start page makes its own, even where
  // the message's submission was never acknowledged here.
  useEffect(() => {
    if (input.selectedConversationId) stagedConversation.current = undefined;
  }, [input.selectedConversationId]);
  // Removal settles after later renders, so it reads the uploads and callback of that moment.
  const latest = useRef({ input, localUploadingAttachments, stagedFiles });
  latest.current = { input, localUploadingAttachments, stagedFiles };
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
    ...draftAttachmentPolling
  });
  const draftAttachments = input.selectedConversationId ? (draftAttachmentsQuery.data ?? []) : [];
  const visibleUploadingAttachments = input.selectedConversationId
    ? localUploadingAttachments.filter(
        (attachment) => attachment.conversationId === input.selectedConversationId
      )
    : stagedFiles.map(({ file: _file, uploadedAs: _uploadedAs, ...attachment }) => attachment);

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
    const conversationId = input.selectedConversationId;
    if (!conversationId) {
      stageFiles(selectedFiles);
      return;
    }
    try {
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

  function stageFiles(files: File[]) {
    const accepted = files.filter((file) => shouldUploadFile(file, [], stagedFiles));
    setStagedFiles((current) => [
      ...current,
      ...accepted.map((file) => ({
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${file.name}`,
        file,
        filename: file.name,
        byteSize: file.size,
        mimeType: file.type || undefined,
        status: "staged" as const
      }))
    ]);
  }

  async function sendStagedFiles(): Promise<string | undefined> {
    const staged = latest.current.stagedFiles;
    if (staged.length === 0) {
      // A failed send's conversation takes the message, also once its files were all taken out.
      return stagedConversation.current?.id;
    }
    const restage = (uploaded: ReadonlyMap<string, string> = new Map()) =>
      setStagedFiles((current) =>
        current.map((file) => ({
          ...file,
          status: "staged",
          uploadedAs: file.uploadedAs ?? uploaded.get(file.id)
        }))
      );
    setStagedFiles((current) => current.map((file) => ({ ...file, status: "uploading" })));
    const conversation =
      stagedConversation.current ??
      (await input
        .createConversationForFiles(staged.map((stagedFile) => stagedFile.file))
        .catch((error: unknown) => {
          restage();
          throw error;
        }));
    // Read again after the wait: a conversation made while the person moved to another
    // workspace, or opened a conversation, is not held for the next start page.
    const now = latest.current.input;
    if (
      now.collaborationWorkspaceId === input.collaborationWorkspaceId &&
      now.selectedConversationId === undefined
    ) {
      stagedConversation.current = conversation;
    }
    const queryKey = workspaceQueryKeys.draftAttachments(
      input.apiBaseUrl,
      input.authScope,
      conversation.id
    );
    const waiting = staged.filter((stagedFile) => stagedFile.uploadedAs === undefined);
    const uploads = await Promise.allSettled(
      waiting.map(({ file }) =>
        uploadLimiter.current(() =>
          uploadFileWithRetry(file, (readFile) =>
            input.client.conversations.draft_attachments.upload({
              params: { conversationId: conversation.id },
              query: { agentName: input.agentName },
              file: readFile
            })
          )
        )
      )
    );
    const uploaded = new Map<string, string>();
    let refusal: string | undefined;
    uploads.forEach((upload, index) => {
      const stagedFile = waiting[index];
      if (!stagedFile) return;
      if (upload.status === "fulfilled") {
        uploaded.set(stagedFile.id, upload.value.attachment.id);
      } else {
        refusal ??= uploadErrorMessage(upload.reason, stagedFile.filename, t);
      }
    });
    if (refusal !== undefined) {
      // A refused upload leaves nothing to retry in the conversation: the files stay here. A
      // conversation that took none of them is discarded, so no row named after a refused file
      // is left behind, and the next send makes a new one; one that took a file is kept for it.
      if (
        uploaded.size === 0 &&
        staged.every((stagedFile) => stagedFile.uploadedAs === undefined)
      ) {
        await discardEmptyConversation(conversation.id);
      }
      restage(uploaded);
      throw new Error(refusal);
    }
    const attachments = await settledDraftAttachments(input.client, conversation.id, ended).catch(
      (error: unknown) => {
        restage(uploaded);
        throw error;
      }
    );
    setStagedFiles([]);
    queryClient.setQueryData(queryKey, attachments);
    const blocked = getSendBlockedReason(attachments, []);
    if (blocked) {
      // The files are in the conversation now: it opens, and they are retried or removed there.
      queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
      latest.current.input.showConversationForFiles(conversation);
      throw new Error(blocked);
    }
    return conversation.id;
  }

  /**
   * Deletes a conversation made for files none of which it took. The instance deletes it only
   * while it holds no message and no file of the person's, and keeps it otherwise.
   */
  async function discardEmptyConversation(conversationId: string): Promise<void> {
    if (stagedConversation.current?.id === conversationId) stagedConversation.current = undefined;
    await input.client.conversations
      .delete({ params: { conversationId }, query: { discardEmpty: "true" } })
      .then(
        () =>
          queryClient.invalidateQueries({
            queryKey: workspaceQueryKeys.conversationsScope(input.apiBaseUrl, input.authScope)
          }),
        // Not empty after all, or not reached: the refusal of the file is what the person reads.
        () => undefined
      );
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
            query: { agentName: input.agentName },
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
      const uploadedAs = stagedFiles.find((file) => file.id === attachmentId)?.uploadedAs;
      const madeFor = stagedConversation.current;
      setStagedFiles((current) => withoutDraftAttachment(current, attachmentId));
      // A file a failed send already uploaded leaves the conversation made for it as well.
      if (uploadedAs && madeFor) {
        input.client.conversations.draft_attachments
          .delete({ params: { conversationId: madeFor.id, attachmentId: uploadedAs } })
          .catch((error: unknown) =>
            input.onError(error instanceof ApiError ? error.message : "Remove failed")
          );
      }
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
    // Called once the conversation's message was submitted: the start page lets it go.
    if (stagedConversation.current?.id === conversationId) stagedConversation.current = undefined;
    setLocalUploadingAttachments((currentAttachments) =>
      currentAttachments.filter((attachment) => attachment.conversationId !== conversationId)
    );
  }

  return {
    draftAttachments,
    visibleUploadingAttachments,
    sendBlockedReason: getSendBlockedReason(
      draftAttachments,
      visibleUploadingAttachments.filter((attachment) => attachment.status === "uploading")
    ),
    onFilesSelected,
    sendStagedFiles,
    onRemoveDraftAttachment,
    onRetryDraftAttachment,
    clearConversationUploads
  };
}

/**
 * How the list of draft attachments is kept current. A message cannot be sent while one of its
 * files is processed, so the list is read once a second until none is, also while the page is
 * hidden: a tab in the background would otherwise show "Queued" until somebody looked at it
 * again. It is read once more when the page comes back, whatever its age.
 */
export const draftAttachmentPolling = {
  refetchInterval: (query: { state: { data: DraftAttachment[] | undefined } }) =>
    hasProcessingDraftAttachments(query.state.data ?? []) ? DRAFT_ATTACHMENT_POLL_MS : false,
  refetchIntervalInBackground: true,
  refetchOnWindowFocus: "always"
} as const;

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

/**
 * The draft attachments of a conversation once none of them is still processed, or as they
 * stand after a bounded wait. Stops when the page that waits is gone.
 */
async function settledDraftAttachments(
  client: ApiClient,
  conversationId: string,
  ended: { readonly current: boolean }
): Promise<DraftAttachment[]> {
  for (let poll = 1; ; poll += 1) {
    if (ended.current) {
      throw new Error("The page that sent the files is gone.");
    }
    const attachments = await listAll((paging) =>
      client.conversations.draft_attachments.list({ params: { conversationId }, query: paging })
    );
    if (!hasProcessingDraftAttachments(attachments) || poll >= DRAFT_ATTACHMENT_SETTLE_POLLS) {
      return attachments;
    }
    await new Promise((resolve) => setTimeout(resolve, DRAFT_ATTACHMENT_POLL_MS));
  }
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
  localUploadingAttachments: LocalUploadingAttachment[]
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
