import {
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject
} from "react";
import { cn } from "../cn";
import { Select } from "../forms/select";
import type { CountBadgeTone } from "../status/count-badge";
import { NavGroup, NavItem } from "./nav-item";

export interface SubRailItem {
  /** In `routes` mode the route's own id; in `anchors` mode the id of the element to scroll to. */
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
  countTone?: CountBadgeTone;
  /** `routes` mode: the caller's link to this route. Without it the item is a button. */
  link?: ReactElement;
}

export interface SubRailGroup {
  id: string;
  label?: string;
  items: readonly SubRailItem[];
}

interface SubRailBaseProps {
  /** Names the navigation, and the select that replaces it below 1024 px. */
  label: string;
  groups: readonly SubRailGroup[];
  /** Above the groups, for a control that switches what the whole rail is about. */
  scope?: ReactNode;
  /** The page has a sticky detail header: the rail stays below it. */
  belowHeader?: boolean;
  className?: string;
}

export interface SubRailRoutesProps extends SubRailBaseProps {
  /** Each item is a page. The caller's links navigate; the rail shows where the reader is. */
  mode: "routes";
  /** The id of the open route. */
  value: string;
  /** An item without a link, or the select, was chosen: the caller navigates to this route. */
  onValueChange(id: string): void;
}

export interface SubRailAnchorsProps extends SubRailBaseProps {
  /** Each item is a section of this page. The rail scrolls to it and follows the scrolling. */
  mode: "anchors";
  /** The section at the top of the view changed. */
  onValueChange?(id: string): void;
}

export type SubRailProps = SubRailRoutesProps | SubRailAnchorsProps;

/**
 * Grouped navigation inside a page, 14rem wide and built from `NavItem`. Below 1024 px it is
 * the library's `Select` above the content.
 */
export function SubRail(props: SubRailProps) {
  const { label, groups, scope, belowHeader = false, className } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const ids = groups.flatMap((group) => group.items.map((item) => item.id));
  const anchors = useAnchorTracking({
    enabled: props.mode === "anchors",
    ids,
    rootRef,
    railRef,
    onChange: props.mode === "anchors" ? props.onValueChange : undefined
  });
  const value = props.mode === "routes" ? props.value : anchors.value;
  const choose = props.mode === "routes" ? props.onValueChange : anchors.scrollTo;

  return (
    <div
      ref={rootRef}
      data-mode={props.mode}
      className={cn(
        "sticky z-(--layer-sticky-header) grid w-full shrink-0 gap-3 self-start bg-background py-2 lg:w-(--layout-subrail) lg:py-0",
        belowHeader ? "top-(--layout-header)" : "top-0",
        className
      )}
    >
      {scope}
      <Select
        className="lg:hidden"
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
      <nav ref={railRef} aria-label={label} className="hidden gap-4 lg:grid">
        {groups.map((group) => (
          <NavGroup key={group.id} label={group.label}>
            {group.items.map((item) => (
              <SubRailNavItem
                key={item.id}
                item={item}
                mode={props.mode}
                selected={item.id === value}
                onChoose={choose}
              />
            ))}
          </NavGroup>
        ))}
      </nav>
    </div>
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
  mode,
  selected,
  onChoose
}: {
  item: SubRailItem;
  mode: SubRailProps["mode"];
  selected: boolean;
  onChoose(id: string): void;
}) {
  const shared = {
    icon: item.icon,
    count: item.count,
    countTone: item.countTone ?? "muted",
    selected
  };
  if (mode === "anchors") {
    const followAnchor = (event: MouseEvent) => {
      event.preventDefault();
      onChoose(item.id);
    };
    return (
      <NavItem {...shared} asChild aria-current={selected ? "location" : undefined}>
        <a href={`#${item.id}`} onClick={followAnchor}>
          {item.label}
        </a>
      </NavItem>
    );
  }
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

interface AnchorMeasure {
  /** The vertical position, in the viewport, that a section has reached when it is "current". */
  line: number;
  targets: { id: string; element: HTMLElement }[];
}

/**
 * `anchors` mode: which section is at the top of the view, and scrolling to one. The line the
 * sections are measured against is the rail's own top edge, or the bottom edge of the select
 * that stands in for the rail, because either one is the sticky thing the content passes.
 */
function useAnchorTracking({
  enabled,
  ids,
  rootRef,
  railRef,
  onChange
}: {
  enabled: boolean;
  ids: readonly string[];
  rootRef: RefObject<HTMLDivElement | null>;
  railRef: RefObject<HTMLElement | null>;
  onChange?(id: string): void;
}): { value: string; scrollTo(id: string): void } {
  const [value, setValue] = useState(ids[0] ?? "");
  const valueRef = useRef(value);
  const ownScrollRef = useRef<{ scroller: Element; top: number } | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  // The ids as one string, so a new array with the same ids does not restart the tracking.
  const idsKey = ids.join("\n");

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const select = useCallback((id: string) => {
    if (valueRef.current === id) {
      return;
    }
    valueRef.current = id;
    setValue(id);
    onChangeRef.current?.(id);
  }, []);

  const measure = useCallback((): AnchorMeasure | undefined => {
    const root = rootRef.current;
    const rail = railRef.current;
    if (!root || !rail) {
      return undefined;
    }
    const rect = root.getBoundingClientRect();
    const narrow = getComputedStyle(rail).display === "none";
    const targets = idsKey.split("\n").flatMap((id) => {
      const element = findById(root, id);
      return element ? [{ id, element }] : [];
    });
    return { line: narrow ? rect.bottom : rect.top, targets };
  }, [idsKey, rootRef, railRef]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const follow = () => {
      const measured = measure();
      const first = measured?.targets[0];
      if (!measured || !first) {
        return;
      }
      const last = measured.targets[measured.targets.length - 1] ?? first;
      const scroller = scrollParent(first.element);
      // Where the rail itself scrolled to, its choice stands: a section near the end cannot reach the line.
      const own = ownScrollRef.current;
      if (own?.scroller === scroller && own.top === scroller.scrollTop) {
        return;
      }
      ownScrollRef.current = undefined;
      const atEnd =
        scroller.scrollTop > 0 &&
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      const passed = measured.targets.filter(
        (target) => target.element.getBoundingClientRect().top <= measured.line + 1
      );
      select(atEnd ? last.id : (passed[passed.length - 1] ?? first).id);
    };
    follow();
    // Scroll events do not bubble; capturing on the document hears every scrolling ancestor.
    document.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("resize", follow);
    return () => {
      document.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
    };
  }, [enabled, measure, select]);

  const scrollTo = (id: string) => {
    const measured = measure();
    const target = measured?.targets.find((candidate) => candidate.id === id);
    if (!measured || !target) {
      return;
    }
    const scroller = scrollParent(target.element);
    scroller.scrollBy({
      top: target.element.getBoundingClientRect().top - measured.line,
      behavior: "instant"
    });
    ownScrollRef.current = { scroller, top: scroller.scrollTop };
    select(id);
  };

  return { value, scrollTo };
}

/** The element with `id` in the document or shadow root that `from` lives in. */
function findById(from: HTMLElement, id: string): HTMLElement | null {
  const rootNode = from.getRootNode();
  return rootNode instanceof Document || rootNode instanceof ShadowRoot
    ? rootNode.getElementById(id)
    : null;
}

function scrollParent(element: HTMLElement): Element {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    ) {
      return parent;
    }
  }
  return element.ownerDocument.scrollingElement ?? element.ownerDocument.documentElement;
}
