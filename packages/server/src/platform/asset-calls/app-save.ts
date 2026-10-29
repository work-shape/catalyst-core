import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import {
  isAppError,
  type Conversation,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import {
  type AppSaveInput,
  type AppSaved,
  type PlatformAssetCalls
} from "@work-shape/catalyst-tool-execution";
import {
  DRAFT_OF_OTHER_FOLDER,
  askAboutDraft,
  draftNotWritten,
  draftRefusal
} from "../../apps/page-app-drafts";
import { wasKeptByFormerSave } from "../../apps/former-page-saves";
import {
  requireOwnTranscript,
  subjectUnavailable
} from "../../conversations/platform-asset-subject";
import { type AssetCallScope, ASSET_WRITE_OPERATION } from "./scope";

/** The operations a Page's way into an App projects, beside `assets.put` of the App. */
const APP_FROM_PAGE_OPERATIONS = {
  create: "apps.create_from_page",
  draft: "apps.update_from_page"
} as const;

/** How many revisions of an App back a save of a Page looks for one written from that Page. */
const APP_REVISIONS_LOOKED_BACK = 200;

/** Saving a Page as an App, or as the next draft of the App the conversation is about. */
export function appSaveCalls(
  scope: AssetCallScope
): Pick<PlatformAssetCalls, "appSaveBeforeEvents" | "saveApp" | "appSavePolicyFloor"> {
  const { options, centralFloor, titleOf, pageApps, conversationOf, callOf } = scope;
  /** Whether a revision of the App `name` was ever written from the Page `fromPage` names. */
  async function wasWrittenFrom(
    name: string,
    fromPage: (origin: { pageId: string; conversationId: string }) => boolean
  ): Promise<boolean> {
    const revisions = await options.configAssets.store.listConfigAssetRevisions({
      clientInstanceId: options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name,
      newestFirst: true,
      page: { limit: APP_REVISIONS_LOOKED_BACK }
    });
    return revisions.some(({ origin }) => origin?.kind === "page" && fromPage(origin));
  }

  async function changedDraft(name: string, revision: number): Promise<string> {
    const saved = await options.configAssets.store.getConfigAssetRevision({
      clientInstanceId: options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name,
      revision
    });
    const who = saved?.actor?.displayLabel ?? "another editor";
    const when = saved ? ` at ${saved.createdAt}` : "";
    return `The App's draft was saved by ${who}${when} since this working copy was loaded. Nothing was written. Call app.edit with name '${name}' to load the current draft, then redo your change and save again.`;
  }

  /**
   * A later save in a conversation about the App `name`: the Page's revision becomes the App's
   * next draft revision. Only the App this Page became, or was put into, is written; a draft
   * written elsewhere since is not written over, and the answer says why.
   */
  async function saveIntoSubjectApp(
    context: ToolExecutionContext,
    conversation: Conversation,
    name: string,
    input: AppSaveInput
  ): Promise<AppSaved> {
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name
    });
    if (
      row?.status !== "active" ||
      row.scope.kind !== "workspace" ||
      row.scope.workspaceId !== conversation.collaborationWorkspaceId
    ) {
      throw subjectUnavailable();
    }
    // A name a person gave stands: the save keeps it, and says so to the agent.
    const app = {
      name: row.name,
      title: titleOf(APP_ASSET_KIND, row.name, row.config ?? {}, context.locale),
      ...(row.personTitle === undefined ? {} : { nameSetByPerson: true as const })
    };
    await requireOwnTranscript(options, conversation);
    try {
      (await callOf(context)).access.require("app.write", {
        kind: APP_ASSET_KIND,
        name: row.name,
        assetId: row.id,
        workspaceId: row.scope.workspaceId
      });
    } catch (error) {
      return draftNotWritten(app, draftRefusal(error, options.logger));
    }
    const page = await pageApps.named(conversation.id, input.page);
    const checkout = await options.configAssets.store.getAssetCheckout({
      clientInstanceId: options.clientInstanceId,
      conversationId: conversation.id,
      folder: page.name
    });
    if (checkout && checkout.assetId !== row.id) return draftNotWritten(app, DRAFT_OF_OTHER_FOLDER);
    if (!checkout) {
      // Only old build chats need their Page origin. Every current save uses its checkout.
      const origin = await options.configAssets.store.getConfigAssetPageOrigin({
        clientInstanceId: options.clientInstanceId,
        assetId: row.id
      });
      const fromThisPage = (named: { pageId: string; conversationId: string } | undefined) =>
        named?.pageId === page.id && named.conversationId === conversation.id;
      const linkFormer =
        !fromThisPage(origin) &&
        origin?.conversationId === conversation.id &&
        (await wasKeptByFormerSave(options.stores.conversations, {
          clientInstanceId: options.clientInstanceId,
          conversationId: conversation.id,
          pageId: origin.pageId,
          pageName: page.name
        }));
      // A legacy working copy gets a base only while its own last save is still the draft.
      const legacyBase =
        (fromThisPage(origin) || linkFormer) &&
        row.revisionOrigin?.kind === "page" &&
        row.revisionOrigin.pageId === (linkFormer ? origin?.pageId : page.id);
      if (!legacyBase) {
        return draftNotWritten(
          app,
          (await wasWrittenFrom(row.name, fromThisPage))
            ? await changedDraft(row.name, row.revision)
            : DRAFT_OF_OTHER_FOLDER
        );
      }
    }
    if (
      checkout &&
      (checkout.baseRevision !== row.revision || checkout.baseCommit !== row.commit)
    ) {
      return draftNotWritten(app, await changedDraft(row.name, row.revision));
    }
    // The revision the preview shows is the draft, which the guardrails answer first.
    const asked = await askAboutDraft(options.operationCalls?.deps.events, context, pageApps, {
      app: row.name,
      workspaceId: row.scope.workspaceId,
      fileSetId: input.fileSetId,
      page
    });
    if ("refusal" in asked) return draftNotWritten(app, asked.refusal);
    const { event, warnings } = asked;
    try {
      const updated = await pageApps.update(
        await callOf(context),
        page,
        {
          app: row.name,
          workspaceId: row.scope.workspaceId,
          expectedRevision: row.revision,
          link: true,
          fileSetId: input.fileSetId
        },
        [event]
      );
      return {
        kind: "app",
        ...app,
        saved: true,
        created: false,
        revision: updated.revision,
        ...(warnings.length > 0 ? { warnings } : {})
      };
    } catch (error) {
      // A write of the App that did not happen is the answer's, not a failed call.
      if (
        isAppError(error) &&
        (error.code === "REVISION_CONFLICT" ||
          (error.code === "CONFLICT" &&
            typeof error.details === "object" &&
            error.details !== null &&
            "reason" in error.details &&
            error.details.reason === "draft_moved"))
      ) {
        const current = await options.configAssets.store.getConfigAsset({
          clientInstanceId: options.clientInstanceId,
          kind: APP_ASSET_KIND,
          name: row.name
        });
        return draftNotWritten(
          app,
          await changedDraft(row.name, current?.revision ?? row.revision)
        );
      }
      return draftNotWritten(app, draftRefusal(error, options.logger));
    }
  }

  return {
    async appSaveBeforeEvents(conversationId, input) {
      const { clientInstanceId, stores } = options;
      const conversation = await stores.conversations.getConversation(
        clientInstanceId,
        conversationId
      );
      // A conversation that is gone, or a Page it does not hold, is refused by the save itself.
      // A later save asks the guardrails when it writes the draft.
      if (!conversation || conversation.subject?.kind === APP_ASSET_KIND) return [];
      return [
        pageApps.writeEvent({
          app: input.name,
          title: input.title,
          workspaceId: conversation.collaborationWorkspaceId,
          fileSetId: input.fileSetId,
          page: () => pageApps.named(conversation.id, input.page).catch(() => undefined)
        })
      ];
    },

    async saveApp(context, input) {
      const conversation = await conversationOf(context);
      const subject = conversation.subject;
      if (subject?.kind === APP_ASSET_KIND) {
        return saveIntoSubjectApp(context, conversation, subject.name, input);
      }
      // The App becomes the subject, which a conversation others read never has. It is the App
      // this call creates, in the conversation's own workspace: never an asset of the instance,
      // which only a person's step makes a subject.
      // The Page revision written is the one the guardrails read, or a held call kept.
      await requireOwnTranscript(options, conversation);
      const page = await pageApps.named(conversation.id, input.page);
      const created = await pageApps.create(
        await callOf(context),
        page,
        {
          name: input.name,
          title: input.title,
          workspaceId: conversation.collaborationWorkspaceId,
          fileSetId: input.fileSetId
        },
        context.beforeEvents
      );
      await options.stores.conversations.setConversationSubject({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        subject: { kind: APP_ASSET_KIND, name: created.name }
      });
      return {
        kind: "app",
        name: created.name,
        title: input.title,
        saved: true,
        created: true,
        revision: created.revision
      };
    },

    async appSavePolicyFloor(conversationId) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      if (!conversation) return undefined;
      const workspaceId = conversation.collaborationWorkspaceId;
      // A save in a conversation about an App writes its draft; any other save creates one.
      const subject = conversation.subject;
      if (subject?.kind === APP_ASSET_KIND) {
        return centralFloor([APP_FROM_PAGE_OPERATIONS.draft, ASSET_WRITE_OPERATION], {
          ...subject,
          workspaceId
        });
      }
      return centralFloor([APP_FROM_PAGE_OPERATIONS.create, ASSET_WRITE_OPERATION], {
        kind: APP_ASSET_KIND,
        workspaceId
      });
    }
  };
}
