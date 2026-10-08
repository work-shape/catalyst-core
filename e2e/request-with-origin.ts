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
