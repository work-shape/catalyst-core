import { RELEASE_VERSION, type PlatformDocs } from "@work-shape/catalyst-api-contract";
import { skillConfigSchema } from "@work-shape/catalyst-config-schema";
import { AppError, PLATFORM_DOCS_SKILL_NAME } from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";

/** Exact stored resource keys only: a page id never becomes a file path or an outbound URL. */
function pageId(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("..") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(path)
  );
}

export async function readPlatformDocs(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  page?: string
): Promise<PlatformDocs> {
  const notFound = () => new AppError("NOT_FOUND", "Documentation page not found");
  if (page !== undefined && !pageId(page)) throw notFound();
  const row = await options.stores.configAssets.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: "skill",
    name: PLATFORM_DOCS_SKILL_NAME
  });
  const skill = skillConfigSchema.safeParse(row?.config);
  if (row?.status !== "active" || !skill.success || skill.data.origin !== "release") {
    throw notFound();
  }
  const pages = (skill.data.resources ?? []).flatMap((resource) => {
    if (!resource.path.startsWith("references/") || !resource.path.endsWith(".md")) return [];
    const path = resource.path.slice("references/".length, -".md".length);
    const header = /^# ([^\n]+)\n\n([^\n]*)\n\n/u.exec(resource.content);
    const [, title, description] = header ?? [];
    return pageId(path) && title !== undefined && description !== undefined
      ? [{ path, title, description, markdown: resource.content }]
      : [];
  });
  const release = { version: RELEASE_VERSION };
  if (page === undefined) {
    return {
      release,
      pages: pages.map(({ path, title, description }) => ({ path, title, description }))
    };
  }
  const found = pages.find(({ path }) => path === page);
  if (!found) throw notFound();
  return { release, path: found.path, title: found.title, markdown: found.markdown };
}
