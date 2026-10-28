import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type PersonalChatSkillView
} from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";
import { retryUnlessRefused } from "./workspace-queries";

interface PersonalChatSkillsInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

/**
 * The skills of the signed-in person's Personal Workspace, each with whether every agent may
 * use it in their own chats (SCOPE-MYCHATS). Another person's skill is never in it.
 */
export function useOwnChatSkillsQuery(input: PersonalChatSkillsInput & { enabled: boolean }) {
  return useQuery({
    queryKey: workspaceQueryKeys.ownChatSkills(input.apiBaseUrl, input.authScope),
    queryFn: () => input.client.me.chat_skills.list(),
    enabled: input.enabled,
    retry: retryUnlessRefused
  });
}

/** Switches one of the person's own skills on or off for their own chats. */
export function useSetOwnChatSkillMutation(
  input: PersonalChatSkillsInput & { heldMessage: string }
) {
  const queryClient = useQueryClient();
  const queryKey = workspaceQueryKeys.ownChatSkills(input.apiBaseUrl, input.authScope);
  return useMutation({
    mutationFn: async (change: {
      name: string;
      inMyChats: boolean;
    }): Promise<PersonalChatSkillView> =>
      completedOutput(
        await input.client.me.chat_skills.set({
          params: { name: change.name },
          body: { inMyChats: change.inMyChats }
        }),
        input.heldMessage
      ),
    onSuccess: (stored) =>
      queryClient.setQueryData<{ items: PersonalChatSkillView[] }>(queryKey, (current) =>
        current
          ? {
              items: current.items.map((item) => (item.name === stored.name ? stored : item))
            }
          : current
      )
  });
}
