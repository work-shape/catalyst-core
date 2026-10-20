import {
  platformAssetWriteRefusal,
  type PlatformAssetCalls
} from "@work-shape/catalyst-tool-execution";
import {
  ofInstance,
  requireOwnTranscript,
  requireReadableSubject
} from "../../conversations/platform-asset-subject";
import { type AssetCallScope, withoutSubject, sameSubject } from "./scope";

/** Opening, reading and checking the subject, or a draft the conversation created. */
export function subjectCalls(
  scope: AssetCallScope
): Pick<PlatformAssetCalls, "open" | "get" | "validate"> {
  const { options, workflow, titleOf, conversationOf, bound, readAsset, allowed, otherName } =
    scope;
  return {
    async open(context, named) {
      const conversation = await conversationOf(context);
      const moves = !sameSubject(named, conversation.subject);
      if (moves) {
        // Another asset is opened as one the conversation could have been made about.
        await requireReadableSubject(options, context.user, named);
        await requireOwnTranscript(options, conversation);
      }
      const read = await readAsset(context, conversation, named);
      const opened = {
        ...read,
        title: titleOf(read.kind, read.name, read.config, context.locale)
      };
      if (!moves) return opened;
      // An asset of the instance becomes the subject only by a person's step: the agent's own
      // open is none, since a document or a tool's answer the agent read can ask for it, and
      // the person may change every asset of the instance. The person is offered to go to it,
      // and going there makes it the subject (`conversations.subject.open`).
      if (await ofInstance(options, named)) return { ...opened, awaitsPerson: true };
      // Set once the read stood: a refused open leaves the conversation about what it was.
      await options.stores.conversations.setConversationSubject({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        subject: named
      });
      return opened;
    },

    async get(context, named) {
      const conversation = await conversationOf(context);
      const asset = named ?? conversation.subject;
      if (!asset) throw withoutSubject();
      if (named !== undefined && !sameSubject(named, conversation.subject)) {
        // Another asset is told as the subject would be: one that does not exist and one the
        // person may not read alike. Its definition reaches no transcript that members read
        // who may not read it, as the subject's does not.
        await requireReadableSubject(options, context.user, named);
        await requireOwnTranscript(options, conversation);
      }
      return readAsset(context, conversation, asset);
    },

    async validate(context, config, named) {
      const { subject, address, call } = await bound(context, named);
      const mismatch = otherName(subject, config);
      if (mismatch) return { issues: [mismatch] };
      const input = {
        kind: subject.kind,
        config,
        ...(address.workspaceId === undefined ? {} : { workspaceId: address.workspaceId })
      };
      allowed(await workflow.authorizeValidate(call.access, input));
      try {
        const { issues, warnings } = await workflow.validate(call, input);
        return {
          ...(warnings ? { warnings } : {}),
          issues: issues.map((issue) => ({
            path: (issue.path ?? []).join("."),
            message: issue.message,
            ...(issue.code === undefined ? {} : { code: issue.code })
          }))
        };
      } catch (error) {
        // A kind's own parser refuses a definition by throwing, with its issues and codes.
        const refused = platformAssetWriteRefusal(error);
        if (refused && "issues" in refused) return { issues: refused.issues };
        throw error;
      }
    }
  };
}
