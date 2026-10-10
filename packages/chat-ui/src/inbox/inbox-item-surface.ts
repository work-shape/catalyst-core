import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import type { SurfaceOf } from "../surface/surface";
import type { InboxItemKind, Translate } from "./inbox-item-kinds";

/**
 * The surface of an Inbox item: named by its kind, with what it concerns below. An item that
 * has not arrived yet, or whose kind has no entry, is a plain request.
 */
export function inboxItemSurface(
  itemId: string,
  item: ApprovalRequestView | undefined,
  kindOf: (kind: string) => InboxItemKind | undefined,
  t: Translate
): SurfaceOf<"inbox_item"> {
  const kind = item ? kindOf(item.kind) : undefined;
  return {
    kind: "inbox_item",
    key: `inbox-item:${itemId}`,
    title: t(kind?.label ?? "inbox.kindUnknown"),
    subtitle: item ? kind?.subject?.(item, t) : undefined,
    itemId
  };
}
