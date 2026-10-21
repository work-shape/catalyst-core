import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import {
  compiledActionsOf,
  declaredExternalHostsOf,
  externalHostSchema
} from "@work-shape/catalyst-app-build";
import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromIdentity,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  isFileSetId,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type DraftHostOwner,
  type FileSet,
  type FileSetId,
  type Page,
  type OperationExecutionContext,
  type PolicyTarget,
  type ServedFileSet
} from "@work-shape/catalyst-core";
import { accessResource } from "../assets/asset-access";
import { requireConversationAccess } from "../conversations/conversation-access";
import type { AppContentMode } from "../pages/app-content";
import type { ResolvedChatServerOptions } from "../types";
import { appOutsideHosts, type AppOutsideHosts } from "./app-outside-hosts";
import { APP_ACTIONS } from "./app-kind";

// Outside hosts in a draft after the builder's click (DRAFT-HOSTS-1, ADR-0031). A draft runs
// with the data its viewer can read, and nobody reviewed the hosts it lists; a published
// revision's hosts were reviewed at publish (`app-outside-hosts.ts`). A person may allow a
// host the draft lists for their own view of it: the frame of that person's preview connects
// to it, nobody else's does. The allowance holds until the App is published or its draft
// discarded, and ends for good once a draft no longer lists the host.
//
// Release config switches it (`apps.draftHosts.enabled`, off by default): off, no host is
// offered or accepted, and allowances stored while it was on are not read. An administrator's
// runtime switch is the central policy setting of the operation once OP-2 ships it: a
// `deny` on `apps.allow_draft_host` then refuses the click through `runOperation`, and the
// preview offers no click where the policy denies it.

type DraftHostOptions = Pick<ResolvedChatServerOptions, "clientInstanceId" | "stores" | "config">;

/** Whether the release lets a person allow an outside host for their view of a draft. */
function draftHostsEnabled(options: Pick<DraftHostOptions, "config">): boolean {
  return options.config.apps.draftHosts.enabled;
}

/**
 * Names that reach a private network although the build accepts them as internet hosts. The
 * build refuses `localhost` and the names under `.localhost`, `.local`, `.internal`, `.lan`
 * and `.home.arpa`, and every IP address; these are the names networks commonly give their
 * own devices besides.
 */
const PRIVATE_SUFFIXES = ["home", "corp", "intranet", "private", "localdomain"];

/**
 * Whether a person may allow `host` for a draft: an `https` host name as the build reads it,
 * so no scheme, port, path, wildcard or IP address, and no name of a private network.
 */
function allowableDraftHost(host: string): boolean {
  if (!externalHostSchema.safeParse(host).success) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Whether a person's call is a click in their own signed-in browser: no Service Principal, no
 * key, no embedding host's token and nobody acting for them. Only such a call allows a host.
 */
function clickedByPerson(actor: AuthenticatedIdentity): actor is AuthenticatedUser {
  return (
    !isAuthenticatedServicePrincipal(actor) &&
    actor.authenticationMethod === "session-cookie" &&
    actor.delegatedActor === undefined
  );
}

/** Whose allowances a view of a served file set reads. */
function ownerOf(fileSet: ServedFileSet): DraftHostOwner {
  if (fileSet.asset) return { kind: "app", id: fileSet.asset.id };
  const { owner } = fileSet;
  if (owner.kind !== "page") throw new AppError("INTERNAL", "A Page's file set has no Page");
  return { kind: "page", id: owner.id };
}

/**
 * The outside hosts a frame of a served file set may connect to for its viewer, and those its
 * manifest lists that it may not. A published view connects to what its manifest lists. A
 * draft of an App connects to the hosts its published revision lists, and a Page of a
 * conversation to none; with the release switch on, each also connects to the hosts its
 * viewer allowed for their own view.
 */
export async function frameOutsideHosts(
  options: DraftHostOptions,
  fileSet: ServedFileSet,
  input: { view: AppContentMode; viewerId: string }
): Promise<AppOutsideHosts> {
  const base: AppOutsideHosts = fileSet.asset
    ? await appOutsideHosts(options.stores.pages, {
        clientInstanceId: options.clientInstanceId,
        assetId: fileSet.asset.id,
        view: input.view,
        shown: fileSet,
        publishedFileSetId: fileSet.asset.publishedFileSetId
      })
    : { allowed: [], heldBack: declaredExternalHostsOf(fileSet.manifest) };
  return withViewerAllowances(options, {
    owner: ownerOf(fileSet),
    shownNumber: fileSet.number,
    viewerId: input.viewerId,
    base
  });
}

/**
 * The hosts of a view of a draft once its viewer's own allowances are added: each held-back
 * host the viewer allowed for this draft, where the release switch is on.
 */
export async function withViewerAllowances(
  options: DraftHostOptions,
  input: { owner: DraftHostOwner; shownNumber: number; viewerId: string; base: AppOutsideHosts }
): Promise<AppOutsideHosts> {
  const { base } = input;
  if (base.heldBack.length === 0 || !draftHostsEnabled(options)) return base;
  const allowed = new Set(
    await options.stores.pages.listDraftHostAllowances({
      clientInstanceId: options.clientInstanceId,
      owner: input.owner,
      userId: asUserId(input.viewerId),
      shownNumber: input.shownNumber
    })
  );
  return {
    allowed: [...base.allowed, ...base.heldBack.filter((host) => allowed.has(host))],
    heldBack: base.heldBack.filter((host) => !allowed.has(host))
  };
}

/**
 * What a preview tells its caller about the hosts it holds back: which of them the caller may
 * allow for their own view, and whether the draft reads data a host could receive. Nothing
 * where the release switch is off.
 */
export function draftHostsOffer(
  options: Pick<DraftHostOptions, "config">,
  input: {
    caller: AuthenticatedIdentity;
    mayWrite: boolean;
    heldBack: readonly string[];
    manifest: unknown;
  }
): { allowable: string[]; readsData: boolean } | undefined {
  if (!draftHostsEnabled(options)) return undefined;
  const offered = input.mayWrite && clickedByPerson(input.caller);
  return {
    allowable: offered ? input.heldBack.filter(allowableDraftHost) : [],
    readsData: compiledActionsOf(input.manifest).length > 0
  };
}

/** Whether the caller may change the App a served file set belongs to. */
function mayWriteApp(access: ActorAccess, fileSet: ServedFileSet): boolean {
  const { asset } = fileSet;
  if (asset?.kind !== APP_ASSET_KIND) return false;
  const resource = accessResource(
    APP_ASSET_KIND,
    asset.name,
    asset.workspaceId === undefined
      ? INSTANCE_ASSET_SCOPE
      : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(asset.workspaceId) },
    asset.id,
    asset.appAvailability
  );
  return access.authorize(APP_ACTIONS.write, resource).allowed;
}

/** Removes every person's allowances of hosts for an App's draft: it was discarded. */
export async function removeDraftHosts(
  options: Pick<DraftHostOptions, "clientInstanceId" | "stores">,
  appId: string
): Promise<void> {
  await options.stores.pages.removeDraftHostAllowances({
    clientInstanceId: options.clientInstanceId,
    owner: { kind: "app", id: appId }
  });
}

/**
 * The first `app.save` of a Page: the hosts the person who saves allowed for their own view of
 * the Page hold for their view of the App's draft too, as long as they hold for the Page's
 * revision the App copies. The Page keeps them. Each moved host is recorded. A failure is
 * logged: the App was created, and its draft then holds the hosts back until the person
 * allows them again.
 */
export async function moveDraftHosts(
  options: DraftHostOptions & Pick<ResolvedChatServerOptions, "logger">,
  call: {
    actor: AuthenticatedIdentity;
    audit: OperationExecutionContext["audit"];
    correlationId: string;
  },
  input: {
    page: Pick<Page, "id" | "conversationId">;
    source: Pick<FileSet, "number" | "manifest">;
    app: { id: string; name: string; workspaceId: string };
    fileSetId: FileSetId;
  }
): Promise<void> {
  // The allowances are the person's own, whoever saves for them: a Service Principal has none.
  if (!draftHostsEnabled(options) || isAuthenticatedServicePrincipal(call.actor)) return;
  try {
    const userId = asUserId(getSubjectUserId(call.actor));
    const declared = new Set(declaredExternalHostsOf(input.source.manifest));
    const hosts = (
      await options.stores.pages.listDraftHostAllowances({
        clientInstanceId: options.clientInstanceId,
        owner: { kind: "page", id: input.page.id },
        userId,
        shownNumber: input.source.number
      })
    ).filter((host) => declared.has(host));
    if (hosts.length === 0) return;
    const copy = await options.stores.pages.getAssetFileSet({
      clientInstanceId: options.clientInstanceId,
      assetId: input.app.id,
      fileSetId: input.fileSetId
    });
    if (!copy) return;
    for (const host of hosts) {
      await options.stores.pages.allowDraftHost({
        clientInstanceId: options.clientInstanceId,
        owner: { kind: "app", id: input.app.id },
        userId,
        host,
        fileSetNumber: copy.number,
        allowedAt: new Date().toISOString()
      });
      await call.audit.record({
        type: "app.draft_host_allowed",
        status: "success",
        actor: auditActorFromIdentity(call.actor),
        correlationId: call.correlationId,
        metadata: {
          host,
          kind: APP_ASSET_KIND,
          name: input.app.name,
          assetId: input.app.id,
          workspaceId: input.app.workspaceId,
          fileSetNumber: copy.number,
          movedFrom: { pageId: input.page.id, conversationId: input.page.conversationId }
        }
      });
    }
  } catch (error) {
    options.logger.error(
      { correlationId: call.correlationId, error: error instanceof Error ? error.message : "" },
      `App '${input.app.name}' was saved but the hosts allowed for its Page were not moved to it`
    );
  }
}

const notAvailable = () => new AppError("NOT_FOUND", "The draft is not available");

/** What `apps.allow_draft_host` does, with the checks of each step. */
export class DraftHosts {
  private readonly options: DraftHostOptions;

  constructor(options: DraftHostOptions) {
    this.options = options;
  }

  /**
   * The draft the caller's preview shows and whose allowance they may change, or a refusal:
   * the release switch, a click by the person, a host the build would accept, the draft of
   * an App the caller may write or a Page of a conversation they read, and a host that draft
   * lists and holds back.
   */
  async target(
    actor: AuthenticatedIdentity,
    access: ActorAccess,
    input: { fileSetId: string; host: string }
  ): Promise<{
    owner: DraftHostOwner;
    fileSet: ServedFileSet;
    heldBack: boolean;
    person: AuthenticatedUser;
  }> {
    if (!draftHostsEnabled(this.options)) {
      throw new AppError(
        "NOT_FOUND",
        "This instance does not let a draft reach an outside host before it is published",
        { reason: "draft_hosts_off" }
      );
    }
    if (!clickedByPerson(actor)) {
      throw new AppError(
        "FORBIDDEN",
        "Only a person allows an outside host for a draft, in their own signed-in browser",
        { reason: "draft_host_requires_person" }
      );
    }
    if (!allowableDraftHost(input.host)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "An outside host for a draft is an https host name on the internet, such as 'api.example.com': no scheme, port, path, wildcard, IP address or name of a private network",
        { reason: "draft_host_invalid" }
      );
    }
    const fileSet = isFileSetId(input.fileSetId)
      ? await this.options.stores.pages.getServedFileSet({
          clientInstanceId: this.options.clientInstanceId,
          fileSetId: input.fileSetId
        })
      : undefined;
    if (!fileSet) throw notAvailable();
    if (fileSet.asset) {
      const { asset } = fileSet;
      // The draft the App's writers are served: an older revision is no draft to allow for.
      if (
        asset.kind !== APP_ASSET_KIND ||
        !asset.revisionIds.includes(asset.activeRevisionId) ||
        !mayWriteApp(access, fileSet)
      ) {
        throw notAvailable();
      }
    } else {
      await requireConversationAccess(this.options, fileSet.conversationId, actor);
    }
    const hosts = await frameOutsideHosts(this.options, fileSet, {
      view: "draft",
      viewerId: getSubjectUserId(actor)
    });
    if (![...hosts.allowed, ...hosts.heldBack].includes(input.host)) {
      throw new AppError("VALIDATION_FAILED", "The draft does not list this outside host", {
        reason: "draft_host_not_listed"
      });
    }
    // APP-16 is not built: no action of an App reaches outside data of one person. The save of
    // App exposure on a Connection that sends person context is refused, and so is such a
    // call (`findPersonContextAppIssue`, `refuseAppPersonContext`). When APP-16 lets an App
    // read person-specific data, a draft that does is refused here.
    return {
      owner: ownerOf(fileSet),
      fileSet,
      heldBack: hosts.heldBack.includes(input.host),
      person: actor
    };
  }

  /**
   * What the policy is asked about: the App and its workspace for an App's draft, the
   * workspace of the conversation for a Page.
   */
  async policyTargets(fileSetId: string): Promise<PolicyTarget[]> {
    const fileSet = isFileSetId(fileSetId)
      ? await this.options.stores.pages.getServedFileSet({
          clientInstanceId: this.options.clientInstanceId,
          fileSetId
        })
      : undefined;
    if (!fileSet) return [];
    if (!fileSet.asset) {
      const conversation = await this.options.stores.conversations.getConversation(
        this.options.clientInstanceId,
        fileSet.conversationId
      );
      return conversation ? [{ workspaceId: conversation.collaborationWorkspaceId }] : [];
    }
    return [
      {
        assetKind: fileSet.asset.kind,
        ...(fileSet.asset.workspaceId === undefined
          ? {}
          : { workspaceId: fileSet.asset.workspaceId })
      }
    ];
  }

  /** Stores the allowance and records it. A host the frame connects to already is left as it is. */
  async allow(context: OperationExecutionContext, input: { fileSetId: string; host: string }) {
    const { owner, fileSet, heldBack, person } = await this.target(
      context.actor,
      context.access,
      input
    );
    if (!heldBack) return { host: input.host, allowed: true as const };
    const userId = asUserId(getSubjectUserId(person));
    const { asset } = fileSet;
    const stored = await this.options.stores.pages.allowDraftHost({
      clientInstanceId: this.options.clientInstanceId,
      owner,
      userId,
      host: input.host,
      fileSetNumber: fileSet.number,
      allowedAt: new Date().toISOString(),
      // A publish or a discard since the check above ends what this would allow.
      ...(asset
        ? {
            draftOf: {
              activeRevisionId: asset.activeRevisionId,
              publishedRevisionId: asset.publishedRevisionId
            }
          }
        : {})
    });
    if (!stored) throw notAvailable();
    await context.audit.record({
      type: asset ? "app.draft_host_allowed" : "app.page_draft_host_allowed",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      correlationId: context.correlationId,
      metadata: {
        host: input.host,
        ...(fileSet.asset
          ? {
              kind: APP_ASSET_KIND,
              name: fileSet.asset.name,
              assetId: fileSet.asset.id,
              ...(fileSet.asset.workspaceId === undefined
                ? {}
                : { workspaceId: fileSet.asset.workspaceId }),
              revisionId: fileSet.asset.activeRevisionId
            }
          : { pageId: fileSet.owner.id, conversationId: fileSet.conversationId }),
        fileSetNumber: fileSet.number
      }
    });
    return { host: input.host, allowed: true as const };
  }
}
