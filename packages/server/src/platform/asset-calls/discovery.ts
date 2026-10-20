import { AppError } from "@work-shape/catalyst-core";
import {
  PLATFORM_ASSET_LIST_MAX,
  type PlatformAssetCalls
} from "@work-shape/catalyst-tool-execution";
import { listCallableOperations } from "../platform-callable-operations";
import { readAgentPlatformContext, listAgentVisibleAssets } from "../platform-agent-context";
import { findWorkspaceFiles } from "../../workspaces/workspace-files";
import { type AssetCallScope } from "./scope";

/** What the agent finds on the platform: its context, assets, files and callable operations. */
export function discoveryCalls(
  scope: AssetCallScope
): Pick<PlatformAssetCalls, "readContext" | "listAssets" | "listFiles" | "listOperations"> {
  const { options, conversationOfCall, conversationOf, callOf } = scope;
  return {
    async readContext(context, input) {
      return readAgentPlatformContext(
        options,
        await callOf(context),
        context,
        await conversationOfCall(context),
        input
      );
    },

    async listAssets(context, input) {
      return listAgentVisibleAssets(
        options,
        await callOf(context),
        context,
        await conversationOfCall(context),
        input
      );
    },

    async listFiles(context, input) {
      const conversation = await conversationOfCall(context);
      if (!conversation) {
        throw new AppError("NOT_FOUND", "This conversation is not available");
      }
      // One more than is answered says whether the list is cut.
      const found = await findWorkspaceFiles(options, {
        user: context.user,
        collaborationWorkspaceId: conversation.collaborationWorkspaceId,
        ...input,
        page: { limit: PLATFORM_ASSET_LIST_MAX + 1 }
      });
      return {
        files: found
          .slice(0, PLATFORM_ASSET_LIST_MAX)
          .map((file) =>
            file.conversation.id === conversation.id ? { ...file, inThisConversation: true } : file
          ),
        truncated: found.length > PLATFORM_ASSET_LIST_MAX
      };
    },

    async listOperations(context, audience, input = {}) {
      // An agent asks while building, before the conversation is about any asset.
      const conversation = await conversationOf(context);
      return listCallableOperations(
        options,
        await callOf(context),
        conversation.id,
        audience,
        input
      );
    }
  };
}
