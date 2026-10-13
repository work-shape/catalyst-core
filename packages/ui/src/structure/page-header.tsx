import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
  type RefObject
} from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";

/**
 * `list` heads a list or settings page: the page name, a description, the primary action.
 * `detail` heads one object: it is one row, `--layout-header` high, and stays at the top while
 * the page scrolls. Its name wins the row. What stands beside the name gives way in this order
 * before the name is cut: the description, the state, the scope chip, the text of
 * `PageHeaderBack`. From 768 px up the head never wraps: a name that still does not fit is cut
 * and says itself whole in a tooltip. In a narrower window the actions go to a second row when
 * they do not fit beside the whole name.
 */
export type PageHeaderVariant = "list" | "detail";

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  variant?: PageHeaderVariant;
  /** A back button or the breadcrumb, before the name. In a `detail` head a `PageHeaderBack`. */
  back?: ReactNode;
  /** The page's or the object's name. */
  title: ReactNode;
  /** `1` for the page's own heading; `2` where the header sits inside a page that has one. */
  headingLevel?: 1 | 2;
  /** The scope chip, after the name. */
  scope?: ReactNode;
  /** The state, such as a draft badge. */
  state?: ReactNode;
  /**
   * One line about the page. A `list` head shows it under the name. A `detail` head shows it
   * after the name and the state on their row, in the muted style: it is cut with an ellipsis
   * where it does not fit, reads in full in a tooltip, and is not shown where a few words have
   * no room.
   */
  description?: ReactNode;
  /** What the tooltip of a `detail` head's description reads, where it holds a control. */
  descriptionTooltip?: ReactNode;
  secondaryActions?: ReactNode;
  primaryAction?: ReactNode;
  /** The overflow menu's button, always last. */
  overflow?: ReactNode;
}

// How a detail head's row shares a width that is too small. A part with the greater factor
// gives all of its width before the next part gives any: the chips, then the way back's text,
// then the name.
const CHIPS_GIVE_WAY = "shrink-[1000000000000]";
const BACK_GIVES_WAY = "has-[[data-slot=page-header-back]]:shrink-[1000000]";

// A box that counts as nothing in the least width of its row and may be any width up to its
// content's.
const NO_LEAST_WIDTH = "grid min-w-0 grid-cols-[minmax(0,max-content)]";

/**
 * Whether the row of a detail head has no room for the text of its way back beside the whole
 * name. The text leaves whole as soon as it would be cut, so the arrow stands alone with no
 * gap where the text was, and returns when the row has room for it after the name.
 */
function useBackTextGone(): [RefObject<HTMLDivElement | null>, boolean] {
  const row = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);
  const was = useRef(false);
  // The text's width, known while it shows.
  const width = useRef(0);
  useLayoutEffect(() => {
    const node = row.current;
    const text = node?.querySelector<HTMLElement>("[data-slot=page-header-back-text]");
    const name = node?.querySelector<HTMLElement>("h1, h2");
    const slot = text?.parentElement;
    if (!node || !text || !name || !slot || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const measure = () => {
      if (!was.current) {
        width.current = text.getBoundingClientRect().width;
      }
      const cut = name.scrollWidth > name.clientWidth;
      // The chips and the description give the room after the name before the text asks for it.
      const free = node.getBoundingClientRect().right - name.getBoundingClientRect().right;
      const next = was.current
        ? cut || free < width.current + 1
        : cut || slot.getBoundingClientRect().width < width.current - 0.5;
      was.current = next;
      setGone(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const observed of [node, name, slot]) {
      observer.observe(observed);
    }
    return () => observer.disconnect();
  });
  return [row, gone];
}

/**
 * The head of a page. Its slots have one order on every page: back or breadcrumb, name, scope
 * chip, state, secondary actions, primary action, overflow.
 */
export function PageHeader({
  className,
  variant = "list",
  back,
  title,
  headingLevel = 1,
  scope,
  state,
  description,
  descriptionTooltip,
  secondaryActions,
  primaryAction,
  overflow,
  ...props
}: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const detail = variant === "detail";
  const [row, backTextGone] = useBackTextGone();
  const hasActions =
    secondaryActions !== undefined || primaryAction !== undefined || overflow !== undefined;
  const actions = hasActions ? (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-2", detail && "md:flex-nowrap")}>
      {secondaryActions}
      {primaryAction}
      {overflow}
    </div>
  ) : null;
  if (detail) {
    return (
      <header
        data-variant={variant}
        // A `PageOutline` measures the pinned head: what it scrolls to rests below it.
        data-page-head=""
        className={cn(
          "sticky top-0 z-(--layer-sticky-header) flex min-h-(--layout-header) min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-background px-(--layout-gutter) py-1 md:flex-nowrap",
          className
        )}
        {...props}
      >
        {/* Beside a floating control the row starts after it, at rest and pinned alike. Its
            least width is the way back without its text and the whole name: the actions wrap
            under a narrow head only when they do not fit beside that. */}
        <div
          ref={row}
          data-back-text-gone={backTextGone ? "" : undefined}
          className="group/page-header-row flex min-w-0 flex-1 basis-[min-content] items-center gap-2 ps-(--layout-page-head-start)"
        >
          {back === undefined ? null : (
            // Where the actions wrapped, the way back stays on the first row: at the middle of
            // the head's least height, level with a control that floats beside the head. The
            // head's line is part of that height, so this box reaches one line's width into it.
            <div
              className={cn(
                "me-1 -mb-px flex h-[calc(var(--layout-header)-var(--spacing)*2)] shrink-0 items-center self-start",
                BACK_GIVES_WAY
              )}
            >
              {back}
            </div>
          )}
          <Heading
            // An area puts the focus here when it opens; a title is no control and shows no ring.
            className={cn("min-w-0 truncate outline-none", "text-title")}
            title={typeof title === "string" ? title : undefined}
          >
            {title}
          </Heading>
          {scope === undefined && state === undefined ? null : (
            // A chip is shown whole or not at all: one that does not fit goes to a second line,
            // and only the first line shows. The pseudo-element that opens the first line takes
            // one gap, so the box starts a gap early. The chips go before the way back's text
            // does, so they stay away while it is gone.
            <div
              className={cn(
                NO_LEAST_WIDTH,
                CHIPS_GIVE_WAY,
                "-ms-2 group-data-back-text-gone/page-header-row:hidden"
              )}
            >
              <div
                data-slot="page-header-chips"
                className="flex h-control-sm min-w-0 flex-wrap items-center gap-x-2 overflow-hidden before:h-full before:w-0 before:content-['']"
              >
                {scope}
                {state}
              </div>
            </div>
          )}
          {description === undefined ? null : (
            <InlineDescription tooltip={descriptionTooltip ?? description}>
              {description}
            </InlineDescription>
          )}
        </div>
        {actions}
      </header>
    );
  }
  return (
    <header
      data-variant={variant}
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-6",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-3">
        {back}
        <div className="grid min-w-0 gap-0.5">
          {/* The title's line is as tall as a control, so the title sits the same with or
              without an action beside it or a description under it. */}
          <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-2">
            <Heading
              // An area puts the focus here when it opens; a title is no control and shows no ring.
              className={cn("min-w-0 break-words outline-none", "text-title-lg")}
            >
              {title}
            </Heading>
            {scope}
            {state}
          </div>
          {description === undefined ? null : (
            <div className="min-w-0 text-body text-muted-foreground">{description}</div>
          )}
        </div>
      </div>
      {actions}
    </header>
  );
}

export type PageHeaderBackProps = {
  /** Names the way back for someone who does not see its text. */
  label: string;
  /** Where it leads. The text gives way to the name of the page: the arrow alone is left. */
  children: ReactNode;
} & (
  | { href: string; onClick?: MouseEventHandler<HTMLAnchorElement> }
  | { href?: undefined; onClick: MouseEventHandler<HTMLButtonElement> }
);

/**
 * The way back in a `detail` head: an arrow and where it leads. In a row too narrow for the
 * page's name it becomes the arrow alone before the name is cut. With `href` it is a link.
 */
export function PageHeaderBack(props: PageHeaderBackProps) {
  const content = (
    <>
      <ArrowLeft aria-hidden="true" />
      <span
        className={cn(
          NO_LEAST_WIDTH,
          "overflow-hidden group-data-back-text-gone/page-header-row:hidden"
        )}
      >
        <span data-slot="page-header-back-text" className="w-max ps-2">
          {props.children}
        </span>
      </span>
    </>
  );
  const shared = {
    "data-slot": "page-header-back",
    variant: "ghost",
    size: "sm",
    // The arrow and its padding are the least width; the text carries the gap, so none is
    // left beside the arrow alone.
    className: "shrink gap-0",
    "aria-label": props.label
  } as const;
  return props.href === undefined ? (
    <Button {...shared} onClick={props.onClick}>
      {content}
    </Button>
  ) : (
    <Button {...shared} asChild>
      <a href={props.href} onClick={props.onClick}>
        {content}
      </a>
    </Button>
  );
}

/**
 * The description on the name's line. It takes the room the name leaves, so it gives way before
 * the name is cut. Where it is cut it takes the focus and a tooltip reads it in full.
 */
function InlineDescription({ children, tooltip }: { children: ReactNode; tooltip: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return undefined;
    }
    const measure = () => setCut(node.scrollWidth > node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children]);
  return (
    // The slot is as wide as the room the name leaves, whatever the description holds. With too
    // little of it for a few words the description is not shown at all.
    <div className="@container flex min-w-0 flex-1 basis-0 items-baseline">
      {/* A line of the name's size and no width: the description stands on the name's baseline. */}
      <span aria-hidden="true" className="invisible w-0 shrink-0 text-title">
        &#8203;
      </span>
      <Tooltip open={cut && open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <div
            ref={ref}
            data-slot="page-header-description"
            tabIndex={cut ? 0 : undefined}
            className="hidden w-full min-w-0 truncate rounded-sm text-caption text-muted-foreground outline-none focus-visible:focus-ring @[8rem]:block"
          >
            {children}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
