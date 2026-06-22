import type { ResumableClientStorage } from "@assistant-ui/react-ai-sdk";

const STORAGE_PREFIX = "vivd-catalyst:chat-stream";

export function createConversationResumableStorage(
  apiBaseUrl: string,
  conversationId: string | undefined
): ResumableClientStorage {
  const key = conversationStreamStorageKey(apiBaseUrl, conversationId ?? "new");
  return {
    getStreamId() {
      return readSessionStorage(key);
    },
    setStreamId(id) {
      writeSessionStorage(key, id);
    },
    clear() {
      clearSessionStorage(key);
    }
  };
}

export function rememberConversationStreamId(
  apiBaseUrl: string,
  conversationId: string,
  streamId: string
): void {
  writeSessionStorage(conversationStreamStorageKey(apiBaseUrl, conversationId), streamId);
}

export function readConversationStreamId(
  apiBaseUrl: string,
  conversationId: string | undefined
): string | null {
  if (!conversationId) {
    return null;
  }
  return readSessionStorage(conversationStreamStorageKey(apiBaseUrl, conversationId));
}

export function clearConversationStreamId(apiBaseUrl: string, conversationId: string): void {
  clearSessionStorage(conversationStreamStorageKey(apiBaseUrl, conversationId));
}

function conversationStreamStorageKey(apiBaseUrl: string, conversationId: string): string {
  return `${STORAGE_PREFIX}:${apiBaseUrl.replace(/\/$/u, "")}:${conversationId}`;
}

function readSessionStorage(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.sessionStorage.getItem(key);
}

function writeSessionStorage(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(key, value);
}

function clearSessionStorage(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.removeItem(key);
}
