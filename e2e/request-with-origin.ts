import { randomUUID } from "node:crypto";
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

const assetListSchema = z.object({
  items: z.array(z.object({ kind: z.string(), name: z.string(), revision: z.number() })),
  nextCursor: z.string().optional()
});
const assetSchema = z.object({
  kind: z.string(),
  name: z.string(),
  revision: z.number(),
  config: z.record(z.string(), z.unknown())
});
const overviewSchema = z.object({ version: z.number(), defaultAgentName: z.string().optional() });

export interface AssetSet {
  version: number;
  defaultAgentName?: string;
  assets: Array<z.infer<typeof assetSchema>>;
}

/** The agents and skills an instance holds, with their content, and its default agent. */
export async function readAssetSet(page: Page, apiBaseUrl: string): Promise<AssetSet> {
  const overview = overviewSchema.parse(
    await (await page.request.get(`${apiBaseUrl}/api/v1/instance/config/assets`)).json()
  );
  const assets: AssetSet["assets"] = [];
  for (const kind of ["agent", "skill"]) {
    let cursor: string | undefined;
    do {
      const query = `limit=200${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const listed = assetListSchema.parse(
        await (await page.request.get(`${apiBaseUrl}/api/v1/assets/${kind}?${query}`)).json()
      );
      for (const { name } of listed.items) {
        assets.push(
          assetSchema.parse(
            await (await page.request.get(`${apiBaseUrl}/api/v1/assets/${kind}/${name}`)).json()
          )
        );
      }
      cursor = listed.nextCursor;
    } while (cursor !== undefined);
  }
  return { ...overview, assets };
}

/**
 * Puts an instance back to a set read before, as one release: every asset of the set is
 * written over what is there, and every asset that was added since is deleted.
 */
export async function restoreAssetSet(page: Page, apiBaseUrl: string, original: AssetSet) {
  const current = await readAssetSet(page, apiBaseUrl);
  const revisionNow = new Map(
    current.assets.map((asset) => [`${asset.kind}:${asset.name}`, asset.revision])
  );
  const kept = new Set(original.assets.map((asset) => `${asset.kind}:${asset.name}`));
  return requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/assets/sync`, {
    headers: { "Idempotency-Key": randomUUID() },
    data: {
      items: [
        ...original.assets.map(({ kind, name, config }) => {
          const expectedRevision = revisionNow.get(`${kind}:${name}`);
          return {
            type: "put",
            kind,
            config,
            ...(expectedRevision === undefined ? {} : { expectedRevision })
          };
        }),
        ...current.assets
          .filter((asset) => !kept.has(`${asset.kind}:${asset.name}`))
          .map(({ kind, name, revision }) => ({
            type: "delete",
            kind,
            name,
            expectedRevision: revision
          }))
      ],
      defaultAgentName: original.defaultAgentName ?? null
    }
  });
}
