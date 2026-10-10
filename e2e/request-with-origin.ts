import { test, type APIRequestContext, type Page } from "@playwright/test";

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
