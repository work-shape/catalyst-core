import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import type { PagedItems } from "./paged-items";

// The assets a chooser offers, of the two owners an asset may name: the workspace that owns
// the asset being edited first, then the instance. Each owner is read a page at a time with its
// own cursor, and the reader asks for the next page of both from the end of the list. The page
// size is the only bound.

/** One asset as `assets.list` answers it. */
export type ListedAsset = Awaited<ReturnType<ApiClient["assets"]["list"]>>["items"][number];

/** Where the next read of one owner starts, or `false` once that owner is read to its end. */
type NextRead = { cursor?: string } | false;

/** Where the next page of each owner starts. */
interface OwnedPageParam {
  own: NextRead;
  instance: NextRead;
}

/** One read of both owners. */
interface OwnedPage {
  own: readonly ListedAsset[];
  instance: readonly ListedAsset[];
  /** Absent once both owners are read to their end. */
  next?: OwnedPageParam;
}

/** What a chooser asks for: the assets of one kind whose name or id holds the search. */
export interface OwnedChoiceQuery {
  kind: string;
  /** The workspace whose assets come first. Left out, only the instance's are read. */
  owner: string | undefined;
  search: string;
  limit: number;
}

/** The first read: both owners from their start, where there is a workspace. */
function firstOwnedPage(owner: string | undefined): OwnedPageParam {
  return { own: owner === undefined ? false : {}, instance: {} };
}

/** Reads the next page of each owner that has one, both at once. */
async function readOwnedPage(
  client: Pick<ApiClient, "assets">,
  { kind, owner, search, limit }: OwnedChoiceQuery,
  param: OwnedPageParam,
  signal: AbortSignal
): Promise<OwnedPage> {
  const read = async (
    from: NextRead,
    workspaceId: string | undefined
  ): Promise<{ items: readonly ListedAsset[]; next: NextRead }> => {
    if (from === false) return { items: [], next: false };
    const page = await client.assets.list({
      params: { kind },
      query: {
        limit,
        ...(search ? { text: search } : {}),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(from.cursor === undefined ? {} : { cursor: from.cursor })
      },
      signal
    });
    return {
      items: page.items,
      next: page.nextCursor === undefined ? false : { cursor: page.nextCursor }
    };
  };
  const [own, instance] = await Promise.all([
    read(owner === undefined ? false : param.own, owner),
    read(param.instance, undefined)
  ]);
  return {
    own: own.items,
    instance: instance.items,
    ...(own.next === false && instance.next === false
      ? {}
      : { next: { own: own.next, instance: instance.next } })
  };
}

/** The assets of every page read, those of the workspace before the instance's. */
function ownedAssetsOf(pages: readonly OwnedPage[]): ListedAsset[] {
  return [...pages.flatMap((page) => page.own), ...pages.flatMap((page) => page.instance)];
}

/** A chooser's read as the screen uses it. */
export interface OwnedChoicesRead<Item> {
  /** What is offered so far, own first. Absent until the first page arrived. */
  choices: PagedItems<Item> | undefined;
  error: unknown;
  fetching: boolean;
  retry(): void;
}

/**
 * A hook: the assets a chooser offers, page after page as the reader asks for more. What was
 * read stays while a new search is read.
 */
export function useOwnedChoices<Item>(
  client: Pick<ApiClient, "assets">,
  queryKey: readonly unknown[],
  query: OwnedChoiceQuery,
  toItem: (asset: ListedAsset) => Item,
  enabled = true
): OwnedChoicesRead<Item> {
  const read = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => readOwnedPage(client, query, pageParam, signal),
    initialPageParam: firstOwnedPage(query.owner),
    getNextPageParam: (page) => page.next,
    retry: false,
    enabled,
    placeholderData: keepPreviousData
  });
  return {
    choices:
      read.data === undefined
        ? undefined
        : {
            items: ownedAssetsOf(read.data.pages).map(toItem),
            ...(read.hasNextPage
              ? {
                  more: {
                    loading: read.isFetchingNextPage,
                    load: () => void read.fetchNextPage().catch(() => undefined)
                  }
                }
              : {})
          },
    error: read.error,
    fetching: read.isFetching,
    retry: () => void read.refetch().catch(() => undefined)
  };
}
