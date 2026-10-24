import { cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "../cn";
import { Select } from "../forms/select";
import type { CountBadgeTone } from "../status/count-badge";
import { NavGroup, NavItem } from "./nav-item";

export interface SubRailItem {
  /** The route's own id. */
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
  countTone?: CountBadgeTone;
  /** The caller's link to this route. Without it the item is a button. */
  link?: ReactElement;
}

export interface SubRailGroup {
  id: string;
  label?: string;
  /**
   * Under the group's label, for a control that switches what this group alone is about, such
   * as the workspace its pages change. As a select the rail shows it while one of the group's
   * items is open.
   */
  scope?: ReactNode;
  /**
   * Beside the content the group's label folds it away. It starts folded and opens while one
   * of its items is open; the reader can fold it again. Needs a `label`. The select above the
   * content lists every item.
   */
  collapsible?: boolean;
  items: readonly SubRailItem[];
}

/**
 * Every item is a page: the caller's links navigate and the rail shows where the reader is. It
 * has no way to scroll within a page. The sections of one page are a `PageOutline`.
 */
export interface SubRailProps {
  /** Names the navigation, and the select that replaces it where the page lacks the room. */
  label: string;
  groups: readonly SubRailGroup[];
  /** Above the groups, for a control that switches what the whole rail is about. */
  scope?: ReactNode;
  /** The page has a sticky detail header: the rail stays below it. */
  belowHeader?: boolean;
  className?: string;
  /**
   * The name of the area these pages belong to, such as Settings. It heads the rail on the
   * page's title line, level with the open page's name. Above the content it stands over the
   * select: beside the control that floats over a narrow window, or under the page's top room.
   */
  title?: string;
  /** The id of the open route. */
  value: string;
  /** An item without a link, or the select, was chosen: the caller navigates to this route. */
  onValueChange(id: string): void;
}

/**
 * Grouped navigation inside a page, 14rem wide and built from `NavItem`. It stands beside the
 * content only while the content keeps 40rem; with less room in its `Page` it is the library's
 * `Select` above the content. It measures the page, not the window, so an open sidebar counts.
 *
 * Beside the content it is pinned where it starts, so it stands still while the content scrolls.
 * A rail longer than the scroll area scrolls on its own.
 *
 * Its first line is on the page's title line. Above the content it keeps the page's top room
 * over itself, less what a floating control already takes; once the page scrolls, the select
 * is pinned at the top edge or under that control, and the room is gone.
 */
export function SubRail({
  label,
  title,
  groups,
  scope,
  belowHeader = false,
  className,
  value,
  onValueChange: choose
}: SubRailProps) {
  const openGroupScope = groups.find((group) =>
    group.items.some((item) => item.id === value)
  )?.scope;

  return (
    <div
      data-sub-rail=""
      className={cn(
        // The select that names the routes stays in view while the page scrolls.
        "sticky grid w-full shrink-0 gap-3 self-start bg-background py-2",
        // Beside the content the rail scrolls on its own when it is longer than the scroll area.
        // That clips what leaves its box, so the box is a step larger on each side than the
        // rail it shows and a focus ring keeps its room.
        "@subrail/page:-mx-1 @subrail/page:w-[calc(var(--layout-subrail)+var(--spacing)*2)] @subrail/page:overflow-y-auto @subrail/page:px-1 @subrail/page:pb-1",
        // Under a head the rail keeps a step of room, at rest and while it is pinned: its first
        // item would otherwise touch the head's line.
        // A head with a second line is taller than the offset: the rail then goes under it.
        // Without a head the pinned position is the one the `Page` starts the rail at, so the
        // rail never travels. Under a head it is pinned directly below the pinned head.
        belowHeader
          ? "top-(--layout-header) z-[calc(var(--layer-sticky-header)-1)] @subrail/page:max-h-[calc(100cqh-var(--layout-header))] @subrail/page:pt-4"
          : [
              "z-(--layer-sticky-header) @subrail/page:top-[calc(var(--layout-page-inset)+var(--layout-page-top)-var(--spacing))] @subrail/page:-mt-1 @subrail/page:max-h-[calc(100cqh-var(--layout-page-inset)-var(--layout-page-top)+var(--spacing))] @subrail/page:pt-1",
              // Above the content: the page's top room that no floating control takes yet.
              "[--subrail-room:max(0rem,var(--layout-page-top)_-_var(--layout-page-inset))]",
              title === undefined
                ? // The room is over the select at rest and scrolls away, down to the rail's
                  // own step of padding.
                  "top-[calc(var(--layout-page-inset)+var(--spacing)*2-max(var(--spacing)*2,var(--subrail-room)))] pt-[max(var(--spacing)*2,var(--subrail-room))]"
                : // The title's line is as high as the floating control's band, or a control
                  // high without one. The rail starts at the top edge, so the title stands in
                  // that band; pinned, the band stays and the room and a bare title line go.
                  "top-[calc(var(--layout-page-inset)-var(--subrail-room)-var(--subrail-title))] -mt-(--layout-page-inset) pt-(--subrail-room) [--subrail-title:max(var(--layout-page-inset),var(--spacing)_*_9)]"
            ],
        // The pinned select keeps what floats over the page's top clear: the content leaves
        // under the select, not between the floating controls. A title's line does the same.
        !belowHeader &&
          title === undefined &&
          "before:absolute before:inset-x-0 before:bottom-full before:h-(--layout-page-inset) before:bg-background @subrail/page:before:hidden",
        className
      )}
    >
      {title === undefined ? null : (
        // No heading: the page's own name is its first heading, and the area's landmark and
        // this navigation are named by the caller.
        <p
          data-subrail-title=""
          className="flex h-(--subrail-title) min-w-0 items-center ps-(--layout-page-head-start) text-title-lg @subrail/page:h-9 @subrail/page:ps-2"
        >
          <span className="truncate">{title}</span>
        </p>
      )}
      {scope}
      {openGroupScope === undefined ? null : (
        <div className="min-w-0 @subrail/page:hidden">{openGroupScope}</div>
      )}
      <Select
        className="@subrail/page:hidden"
        aria-label={label}
        value={value}
        onChange={(event) => choose(event.currentTarget.value)}
      >
        {groups.map((group) =>
          group.label === undefined ? (
            group.items.map((item) => <SubRailOption key={item.id} item={item} />)
          ) : (
            <optgroup key={group.id} label={group.label}>
              {group.items.map((item) => (
                <SubRailOption key={item.id} item={item} />
              ))}
            </optgroup>
          )
        )}
      </Select>
      <nav aria-label={label} className="hidden gap-4 @subrail/page:grid">
        {groups.map((group) => (
          <SubRailNavGroup key={group.id} group={group} value={value}>
            {group.scope === undefined ? null : (
              <div className="min-w-0 px-2 pb-1">{group.scope}</div>
            )}
            {group.items.map((item) => (
              <SubRailNavItem
                key={item.id}
                item={item}
                selected={item.id === value}
                onChoose={choose}
              />
            ))}
          </SubRailNavGroup>
        ))}
      </nav>
    </div>
  );
}

function SubRailNavGroup({
  group,
  value,
  children
}: {
  group: SubRailGroup;
  value: string;
  children: ReactNode;
}) {
  const openItem = group.items.some((item) => item.id === value) ? value : undefined;
  const [open, setOpen] = useState(openItem !== undefined);
  // Opening one of its items opens the group, also when the reader had folded it.
  const [seenItem, setSeenItem] = useState(openItem);
  if (seenItem !== openItem) {
    setSeenItem(openItem);
    if (openItem !== undefined) setOpen(true);
  }
  if (!group.collapsible || group.label === undefined) {
    return <NavGroup label={group.label}>{children}</NavGroup>;
  }
  return (
    <NavGroup label={group.label} collapsible open={open} onOpenChange={setOpen}>
      {children}
    </NavGroup>
  );
}

function SubRailOption({ item }: { item: SubRailItem }) {
  return (
    <option value={item.id}>
      {item.count === undefined ? item.label : `${item.label} (${item.count})`}
    </option>
  );
}

function SubRailNavItem({
  item,
  selected,
  onChoose
}: {
  item: SubRailItem;
  selected: boolean;
  onChoose(id: string): void;
}) {
  const shared = {
    icon: item.icon,
    count: item.count,
    countTone: item.countTone ?? "muted",
    selected
  };
  if (item.link) {
    return (
      <NavItem {...shared} asChild>
        {cloneElement(item.link, undefined, item.label)}
      </NavItem>
    );
  }
  return (
    <NavItem {...shared} onClick={() => onChoose(item.id)}>
      {item.label}
    </NavItem>
  );
}
