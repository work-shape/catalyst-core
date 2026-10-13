import { test, type APIRequestContext, type Page } from "@playwright/test";
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
