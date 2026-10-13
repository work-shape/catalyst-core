import { APP_ASSET_KIND } from "@vivd-catalyst/api-contract";
import { AppError, type FileSet, type Page } from "@vivd-catalyst/core";
import type { AssetCall } from "../asset-access";
import type { PageRevisionOrigin } from "../asset-draft-workflow";
import { recordAssetEvent } from "../asset-target";
import { AssetWorkflow } from "../asset-workflow";
import type { AssetWorkflowOptions } from "../types";
import { appConfigOf } from "./app-kind";

// A Page becoming an App, and an App written again from its Page: the writes themselves, for a
// Page its caller already reached. The API reaches the Page through its conversation's access;
// an agent reaches the Page of the conversation it works in.

const pageNotFound = () => new AppError("NOT_FOUND", "Page is not available");

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
  async create(call: AssetCall, page: Page, input: { name: string; title: string; workspaceId: string }) {
    const { source, origin } = await this.newestRevision(page);
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
    input: { app: string; workspaceId: string; expectedRevision: number; link: boolean }
  ) {
    const { source, origin } = await this.newestRevision(page);
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

  /** The newest revision of a Page, and what a copy of it records. */
  private async newestRevision(page: Page): Promise<{ source: FileSet; origin: PageRevisionOrigin }> {
    const source = await this.options.stores.pages.getPageFileSet({
      clientInstanceId: this.options.clientInstanceId,
      pageId: page.id
    });
    if (!source) {
      throw pageNotFound();
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
