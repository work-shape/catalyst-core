/**
 * The Inbox frame in one place: the area, the item panel, the kind registry and the model. A
 * slice that adds an item kind reads the contract from here.
 */
export { InboxArea, InboxAreaView } from "./inbox-area";
export type { InboxItemActions } from "./inbox-item-actions";
export {
  inboxItemKinds,
  InboxItemKindsProvider,
  type InboxDecision,
  type InboxItemKind
} from "./inbox-item-kinds";
export { InboxItemView } from "./inbox-item-panel";
export { inboxItemSurface } from "./inbox-item-surface";
export { InboxList } from "./inbox-list";
export {
  formatInboxAge,
  inboxRailEntry,
  inboxTabCount,
  inboxTabOfItem,
  inboxTabs,
  orderInboxItems,
  type InboxCounts,
  type InboxTab
} from "./inbox-model";
