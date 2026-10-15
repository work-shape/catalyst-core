import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  PAGE_FILE_SET_HELD_KEY,
  assetScopesEqual,
  isFileSetId,
  normalizePageName,
  type ConversationId,
  type FileSet,
  type FileSetId,
  type OperationBeforeEvent,
  type Page
} from "@work-shape/catalyst-core";
import type { AssetCall } from "../asset-access";
import type { PageRevisionOrigin } from "../asset-draft-workflow";
import { fileSetWriteEvent } from "../asset-guardrail-events";
import { recordAssetEvent, scopeOf } from "../asset-target";
import { AssetWorkflow } from "../asset-workflow";
import type { AssetWorkflowOptions } from "../types";
import { appConfigOf } from "./app-kind";

// A Page becoming an App, and an App written again from its Page: the writes themselves, for a
// Page its caller already reached. The API reaches the Page through its conversation's access;
// an agent reaches the Page of the conversation it works in.

const pageNotFound = () => new AppError("NOT_FOUND", "Page is not available");

/**
 * The Page revision the guardrails of a write from a Page read, by the event that read it: the
 * write copies that one. Kept as long as the call holds its events.
 */
const checkedFileSets = new WeakMap<OperationBeforeEvent, FileSetId>();

/**
 * The Page revision a call names, `undefined` where it names none, and `null` where what it
 * names can be no file set's id.
 */
function requestedFileSet(fileSetId: string | undefined): FileSetId | null | undefined {
  if (fileSetId === undefined) return undefined;
  return isFileSetId(fileSetId) ? fileSetId : null;
}

/** An App as the workflow of every asset addresses it. */
export function appAddress(name: string, workspaceId: string) {
  return { kind: APP_ASSET_KIND, name, workspaceId };
}

export class PageApps {
  private readonly options: AssetWorkflowOptions;
  private readonly assets: AssetWorkflow;

  constructor(options: AssetWorkflowOptions) {
    this.options = options;
    this.assets = new AssetWorkflow(options);
  }

  /**
   * Saves the newest revision of a Page as an App with a draft. The files are copied: the
   * conversation of the Page may expire while the App stays. The App remembers the Page.
   */
  async create(
    call: AssetCall,
    page: Page,
    input: { name: string; title: string; workspaceId: string; fileSetId?: string | undefined },
    checked?: readonly OperationBeforeEvent[]
  ) {
    const { source, origin } = await this.revisionOf(page, input.fileSetId, checked);
    const created = await this.assets.drafts.createFromFileSet(
      call,
      appAddress(input.name, input.workspaceId),
      {
        source,
        origin,
        config: appConfigOf({ name: input.name, title: input.title, manifest: source.manifest }),
        firstCommit: "Create from a Page"
      }
    );
    // The App's own event: the asset, its revision and the commit it names. No content.
    await recordAssetEvent(call, "app.created", {
      kind: APP_ASSET_KIND,
      name: input.name,
      assetId: created.id,
      workspaceId: input.workspaceId,
      revision: created.revision,
      ...(created.commit === undefined ? {} : { commit: created.commit })
    });
    return {
      id: created.id,
      name: input.name,
      workspaceId: input.workspaceId,
      revision: created.revision,
      fileSetId: created.fileSetId
    };
  }

  /**
   * Writes the newest revision of a Page as a new draft revision of the App that is updated
   * from it, and with `link` of an App that was not. Nothing is published: the App's users are
   * served what they were served before. The App keeps the name people read.
   */
  async update(
    call: AssetCall,
    page: Page,
    input: {
      app: string;
      workspaceId: string;
      expectedRevision: number;
      link: boolean;
      fileSetId?: string | undefined;
    },
    checked?: readonly OperationBeforeEvent[]
  ) {
    const { source, origin } = await this.revisionOf(page, input.fileSetId, checked);
    const updated = await this.assets.drafts.replaceFromFileSet(
      call,
      appAddress(input.app, input.workspaceId),
      {
        source,
        origin,
        link: input.link,
        expectedRevision: input.expectedRevision,
        configOf: (current) =>
          appConfigOf({
            name: input.app,
            manifest: source.manifest,
            ...(typeof current.title === "string" ? { title: current.title } : {})
          })
      }
    );
    return {
      id: updated.id,
      name: input.app,
      workspaceId: input.workspaceId,
      revision: updated.revision,
      fileSetId: updated.fileSetId
    };
  }

  /** The Page of a conversation by the name it was saved under. Refuses a name it holds none of. */
  async named(conversationId: ConversationId, name: string): Promise<Page> {
    const wanted = normalizePageName(name);
    const pages = await this.options.stores.pages.listPages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const page = pages.find((candidate) => candidate.name === wanted);
    if (!page) {
      throw new AppError(
        "NOT_FOUND",
        `This conversation has no Page named '${wanted}'. Save it with page.save first`,
        { reason: "page_not_found" },
        { exposeMessage: true }
      );
    }
    return page;
  }

  /**
   * `asset.before_write` of the App a Page is saved as or written into: its definition and the
   * files of the revision the write copies, the one the call names or the newest. Held for an
   * approval, the call keeps that revision, whether a guardrail read it or a policy held it.
   */
  writeEvent(input: {
    app: string;
    title?: string;
    workspaceId: string;
    fileSetId?: string | undefined;
    /** The Page, for a caller who reads it. */
    page(): Promise<Page | undefined>;
  }): OperationBeforeEvent {
    const read = async (): Promise<FileSet | undefined> => {
      const page = await input.page();
      const requested = requestedFileSet(input.fileSetId);
      if (!page || requested === null) return undefined;
      return this.options.stores.pages.getPageFileSet({
        clientInstanceId: this.options.clientInstanceId,
        pageId: page.id,
        ...(requested ? { fileSetId: requested } : {})
      });
    };
    const event: OperationBeforeEvent = {
      ...fileSetWriteEvent(this.options, {
        kind: APP_ASSET_KIND,
        name: input.app,
        read: async () => {
          const fileSet = await read();
          if (!fileSet) return undefined;
          // The write copies this revision, whatever the Page is saved as meanwhile.
          checkedFileSets.set(event, fileSet.id);
          const title = input.title ?? (await this.currentTitle(input.app, input.workspaceId));
          return {
            fileSet,
            config: appConfigOf({
              name: input.app,
              manifest: fileSet.manifest,
              ...(title === undefined ? {} : { title })
            })
          };
        }
      }),
      heldInput: async () => {
        const fileSetId = checkedFileSets.get(event) ?? (await read())?.id;
        return fileSetId ? { [PAGE_FILE_SET_HELD_KEY]: fileSetId } : undefined;
      }
    };
    return event;
  }

  /**
   * The title an App of the workspace keeps when it is written from a Page again. An App of
   * that name in another scope is not the caller's: its title is not read.
   */
  private async currentTitle(name: string, workspaceId: string): Promise<string | undefined> {
    const asset = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name
    });
    if (!asset || !assetScopesEqual(asset.scope, scopeOf(workspaceId))) return undefined;
    const title = asset.config?.title;
    return typeof title === "string" ? title : undefined;
  }

  /**
   * The revision of a Page a write copies, and what a copy of it records: the one the
   * guardrails of `checked` read, the one the call names, or the newest. A revision they read or
   * the call names that is gone is refused, never replaced by another.
   */
  private async revisionOf(
    page: Page,
    fileSetId: string | undefined,
    checked: readonly OperationBeforeEvent[] = []
  ): Promise<{ source: FileSet; origin: PageRevisionOrigin }> {
    const pinned =
      checked.flatMap((event) => checkedFileSets.get(event) ?? []).at(0) ??
      requestedFileSet(fileSetId);
    const source =
      pinned === null
        ? undefined
        : await this.options.stores.pages.getPageFileSet({
            clientInstanceId: this.options.clientInstanceId,
            pageId: page.id,
            ...(pinned ? { fileSetId: pinned } : {})
          });
    if (!source) {
      throw pinned !== undefined
        ? new AppError(
            "CONFLICT",
            "The revision of the Page to copy is gone. Save the App from the Page again."
          )
        : pageNotFound();
    }
    return {
      source,
      origin: {
        kind: "page",
        conversationId: page.conversationId,
        pageId: page.id,
        fileSetNumber: source.number
      }
    };
  }
}
