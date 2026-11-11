import { useQuery } from "@tanstack/react-query";
import type {
  ApiClient,
  CollaborationWorkspaceAgents,
  LocaleCode
} from "@work-shape/catalyst-api-client";
import { retryUnlessRefused } from "./workspace-queries";

/** What a reader of one chat is offered in it, as the instance answers it (CHAT-SHARE-6). */
export type ConversationReaderOffer = Awaited<
  ReturnType<ApiClient["conversations"]["reader_offer"]["get"]>
>;

function readerOfferQueryKey(
  apiBaseUrl: string,
  authScope: string,
  conversationId: string | undefined,
  localePreference: LocaleCode | undefined
) {
  return [
    "conversation-reader-offer",
    apiBaseUrl,
    authScope,
    conversationId,
    localePreference ?? "auto"
  ] as const;
}

/**
 * The chat's workspace by name, whether the person reads the chat from outside it, and the
 * agents their own turns may run there. It reaches the workspace through the chat alone, so a
 * named person who is no member asks it instead of any read of the workspace.
 */
export function useConversationReaderOfferQuery(input: {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  conversationId: string | undefined;
  localePreference: LocaleCode | undefined;
  enabled: boolean;
}) {
  const { client, conversationId, localePreference } = input;
  return useQuery({
    queryKey: readerOfferQueryKey(
      input.apiBaseUrl,
      input.authScope,
      conversationId,
      localePreference
    ),
    queryFn: ({ signal }) =>
      client.conversations.reader_offer.get({
        params: { conversationId: conversationId ?? "" },
        query: localePreference === undefined ? {} : { locale: localePreference },
        signal
      }),
    enabled: input.enabled && conversationId !== undefined,
    retry: retryUnlessRefused
  });
}

/** The offer's agents as the workspace's list gives them, for the chat's agent picker. */
export function readerOfferAgents(offer: ConversationReaderOffer): CollaborationWorkspaceAgents {
  return {
    ...(offer.defaultAgentName === undefined ? {} : { defaultAgentName: offer.defaultAgentName }),
    // An outside reader is shown no section of the workspace's rail.
    visibleSections: [],
    items: offer.agents
  };
}
