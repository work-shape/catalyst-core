import { type APIRequestContext, type Page } from "@playwright/test";
import { expect, test } from "./test";
import { z } from "zod";

export function requestWithOrigin(
  page: Page,
  method: "post" | "patch" | "put" | "delete",
  url: string,
  options?: Parameters<APIRequestContext["post"]>[1]
) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) {
    throw new Error("Browser mutation requests require the configured interface baseURL");
  }
  return page.request[method](url, {
    ...options,
    headers: { ...options?.headers, Origin: new URL(baseURL).origin }
  });
}

/**
 * The revision an asset stands at, read at its address under `/api/v1/assets`: what a replace
 * or a delete of it names as `expectedRevision`.
 */
export async function assetRevision(page: Page, assetUrl: string): Promise<number> {
  const response = await page.request.get(assetUrl);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("revision" in body) ||
    typeof body.revision !== "number"
  ) {
    throw new Error(`No revision at ${assetUrl}: ${response.status()}`);
  }
  return body.revision;
}

const latestRevisionSchema = z.object({
  items: z.array(z.object({ revision: z.number() }))
});

/**
 * The revision a write of an asset is made against, whatever its state: the one it stands at,
 * the revision of its delete where it was deleted, and `null` where the name was never stored.
 * It is what a test names that writes an asset over whatever an earlier run left.
 */
export async function assetBaseRevision(page: Page, assetUrl: string): Promise<number | null> {
  const asset = await page.request.get(assetUrl);
  if (asset.ok()) {
    return assetRevision(page, assetUrl);
  }
  const history = await page.request.get(`${assetUrl}/revisions?limit=1`);
  if (!history.ok()) {
    return null;
  }
  return latestRevisionSchema.parse(await history.json()).items[0]?.revision ?? null;
}

const assetSchema = z.object({
  revision: z.number(),
  config: z.record(z.string(), z.unknown())
});

/** The asset at an address under `/api/v1/assets`, or nothing where none stands there. */
export async function readAsset(
  page: Page,
  assetUrl: string
): Promise<z.infer<typeof assetSchema> | undefined> {
  const response = await page.request.get(assetUrl);
  return response.ok() ? assetSchema.parse(await response.json()) : undefined;
}

const agentDraftSchema = z.object({
  draft: z
    .object({
      revision: z.number(),
      baseRevision: z.number(),
      stale: z.boolean(),
      config: z.record(z.string(), z.unknown()),
      author: z.object({ displayLabel: z.string().optional() })
    })
    .nullable()
});

/** The shared draft, read explicitly by browser tests of the agent save contract. */
export async function readAgentDraft(page: Page, assetUrl: string) {
  const url = new URL(assetUrl);
  url.pathname = url.pathname.replace("/assets/agent/", "/agents/") + "/draft";
  const response = await page.request.get(url.href);
  return agentDraftSchema.parse(await response.json()).draft;
}

/** An administrator's explicit publication, where a test needs a saved draft to be live. */
export async function publishAgentDraft(page: Page, assetUrl: string): Promise<void> {
  await expect
    .poll(async () => (await readAgentDraft(page, assetUrl))?.revision ?? null, { timeout: 30_000 })
    .not.toBeNull();
  const draft = await readAgentDraft(page, assetUrl);
  if (!draft) throw new Error("The agent save left no draft to publish");
  const url = new URL(assetUrl);
  url.pathname += "/publish";
  const workspaceId = url.searchParams.get("workspaceId");
  const published = await requestWithOrigin(page, "post", url.href, {
    data: { revision: draft.revision, ...(workspaceId ? { workspaceId } : {}) }
  });
  expect(published.ok(), await published.text()).toBe(true);
}
