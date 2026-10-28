import type { PlatformAssetCalls } from "@work-shape/catalyst-tool-execution";
import {
  requirePersonsTurn,
  useDataStoreInConversation
} from "../../conversations/conversation-data-stores";
import type { AssetCallScope } from "./scope";

/** The agent's `data_store.use`, in the conversation the call came from (STORE-USE-1). */
export function dataStoreUseCalls(scope: AssetCallScope): Pick<PlatformAssetCalls, "useDataStore"> {
  const { options, conversationOf, callOf } = scope;
  return {
    async useDataStore(context, input) {
      // Before anything is read: a call that is not the person's own turn learns nothing.
      requirePersonsTurn(context);
      const conversation = await conversationOf(context);
      const call = await callOf(context);
      return useDataStoreInConversation(options, {
        conversation,
        actor: context.user,
        access: call.access,
        name: input.name,
        confirmed: false,
        context,
        audit: call.audit
      });
    }
  };
}
