import { KNOWLEDGE_OPERATION_PREFIX } from "@work-shape/catalyst-core";
import type { Message } from "@work-shape/catalyst-api-client";
import { Chip, KeyValue, KeyValueList } from "@work-shape/catalyst-ui";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useWorkspaceThreadQuery } from "../../shared/api/workspace-queries";
import { useTranslation } from "../../shared/i18n";
import type { AppPublishConfirmationAsk } from "../../studio/apps/app-publish-confirmation";
import { readCompatibleUserAttachmentRefs } from "../assistant/assistant-message-compat";
import { WORKSPACE_AUTH_SCOPE } from "../workspace/workspace-chat-state";

// ACCEPT-FIX-11 C1: the confirmation of `knowledge.<id>.add_files` names the Knowledge Base by
// its title and each file by the name its person gave it, as their message of the conversation
// carries it. A file id is never shown; a file the conversation no longer names is counted.

/** A file a call adds: one its person sent with a message of a conversation. */
interface AddedFile {
  conversationId: string;
  fileId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The files a waiting `knowledge.<id>.add_files` call adds, or nothing for any other call. */
export function knowledgeAddFilesCall(decision: {
  operationId: string;
  inputPreview: unknown;
}): AddedFile[] | undefined {
  const { operationId, inputPreview } = decision;
  if (!operationId.startsWith(KNOWLEDGE_OPERATION_PREFIX) || !operationId.endsWith(".add_files")) {
    return undefined;
  }
  if (!isRecord(inputPreview) || !Array.isArray(inputPreview.files)) return undefined;
  const files: AddedFile[] = [];
  for (const file of inputPreview.files) {
    if (!isRecord(file) || typeof file.conversationId !== "string") return undefined;
    if (typeof file.fileId !== "string") return undefined;
    files.push({ conversationId: file.conversationId, fileId: file.fileId });
  }
  return files.length > 0 ? files : undefined;
}

/**
 * The names of the files, in the call's order, as the messages of the thread carry them.
 * Nothing unless the thread names every file: the card never lists part of a call as all of it.
 */
function addedFileNames(
  files: readonly AddedFile[],
  thread:
    { conversation: { id: string }; messages: readonly Pick<Message, "metadata">[] } | undefined
): string[] | undefined {
  if (thread === undefined) return undefined;
  const names = new Map(
    thread.messages.flatMap((message) =>
      readCompatibleUserAttachmentRefs(message).map((ref) => [ref.fileId, ref.filename] as const)
    )
  );
  const found: string[] = [];
  for (const file of files) {
    const name =
      file.conversationId === thread.conversation.id ? names.get(file.fileId) : undefined;
    if (name === undefined) return undefined;
    found.push(name);
  }
  return found;
}

/**
 * The card's lead for an add_files call: the Knowledge Base and the files. The files are read
 * from the conversation they came from; until it is read, or where it names them no longer, the
 * card says how many there are.
 */
export function useKnowledgeAddFilesAsk(
  files: readonly AddedFile[],
  knowledgeBase: string | undefined
): AppPublishConfirmationAsk {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const thread = useWorkspaceThreadQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    conversationId: files[0]?.conversationId,
    enabled: true
  });
  return {
    node: (
      <KnowledgeAddFilesView
        knowledgeBase={knowledgeBase}
        names={addedFileNames(files, thread.data)}
        count={files.length}
      />
    ),
    audience: undefined,
    ready: true
  };
}

/** What an add_files call adds, and to which Knowledge Base. */
function KnowledgeAddFilesView({
  knowledgeBase,
  names,
  count
}: {
  knowledgeBase: string | undefined;
  names: readonly string[] | undefined;
  count: number;
}) {
  const { locale, t } = useTranslation();
  return (
    <KeyValueList data-testid="knowledge-add-files">
      {knowledgeBase ? (
        <KeyValue label={t("toolDecisionKnowledgeBase")} data-field="knowledge-base">
          <span className="wrap-anywhere">{knowledgeBase}</span>
        </KeyValue>
      ) : null}
      <KeyValue label={t("toolDecisionFiles")} data-field="files">
        {names ? (
          <span className="flex min-w-0 flex-wrap gap-1">
            {names.map((name, index) => (
              <Chip key={`${index}:${name}`} size="sm">
                {name}
              </Chip>
            ))}
          </span>
        ) : (
          t(count === 1 ? "toolDecisionFileCountOne" : "toolDecisionFileCount", {
            count: new Intl.NumberFormat(locale).format(count)
          })
        )}
      </KeyValue>
    </KeyValueList>
  );
}
