import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
  type RefObject
} from "react";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { cn } from "../cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../overlays/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";
import { useUiLabels } from "../ui-root";

const PageHeaderShellActionContext = createContext<ReactNode>(null);

/**
 * A control the application's shell puts into the head of every page, before the page's own
 * actions: such as the button that brings back a panel the shell holds beside every page. Only
 * a page's own heading, a head of level 1, shows it.
 */
export function PageHeaderShellAction({
  action,
  children
}: {
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageHeaderShellActionContext.Provider value={action}>
      {children}
    </PageHeaderShellActionContext.Provider>
  );
}

/**
 * `list` heads a list or settings page: the page name, a description, the primary action.
 * `detail` heads one object: it is one row, `--layout-header` high, and stays at the top while
 * the page scrolls. Its name wins the row. What stands beside the name gives way in this order
 * before the name gives way: the description, the state, the scope chip, the text of
 * `PageHeaderBack`. From 768 px up the head never wraps: a name that still does not fit takes a
 * second line, is then cut, and says itself whole in a tooltip. In a narrower window the actions
 * go to a second row when they do not fit beside the whole name.
 *
 * Either head keeps its actions on one line. Where that line has no room for all of them, the
 * secondary actions move into the "…" menu, first in it, and the primary action stays: a label is
 * never cut.
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
  /** Shown as buttons before the primary action, or in the "…" menu where they do not fit. */
  secondaryActions?: readonly PageHeaderAction[];
  primaryAction?: ReactNode;
  /**
   * The items of the "…" menu, such as `DropdownMenuItem`s. The head draws the menu's button,
   * always last, also without items when the secondary actions moved into it.
   */
  menu?: ReactNode;
}

/** One secondary action of a head: a button in the row, an item of the "…" menu without room. */
export interface PageHeaderAction {
  label: string;
  icon?: ReactNode;
  onSelect(): void;
  loading?: boolean;
  disabled?: boolean;
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
 * Measures again a frame after any of `nodes` changed its size. The head's measures change its
 * layout: run inside the observer's callback, the head's two observers would see each other's
 * change in the same frame, which the browser reports as a ResizeObserver loop.
 */
function observeAFrameLater(
  nodes: readonly Element[],
  measure: () => void
): { disconnect(): void } {
  let frame = 0;
  const observer = new ResizeObserver(() => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(measure);
  });
  for (const node of nodes) {
    observer.observe(node);
  }
  return {
    disconnect() {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    }
  };
}

/** Whether a detail head's name no longer stands whole on one line: it wrapped or was cut. */
function nameGaveWay(name: HTMLElement): boolean {
  const line = Number.parseFloat(getComputedStyle(name).lineHeight);
  return name.scrollWidth > name.clientWidth || name.scrollHeight > line + 1;
}

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
      const cut = nameGaveWay(name);
      // The chips and the description give the room after the name before the text asks for it.
      // A description holds all of that room; the gap before it is no room the text could take.
      const room = node.querySelector<HTMLElement>("[data-slot=page-header-description-room]");
      const free = room
        ? room.getBoundingClientRect().width
        : node.getBoundingClientRect().right - name.getBoundingClientRect().right;
      const next = was.current
        ? cut || free < width.current + 1
        : cut || slot.getBoundingClientRect().width < width.current - 0.5;
      was.current = next;
      setGone(next);
    };
    measure();
    const observer = observeAFrameLater([node, name, slot], measure);
    return () => observer.disconnect();
  });
  return [row, gone];
}

/**
 * Whether a head's actions do not fit on one line of it: the secondary actions then stand in the
 * "…" menu. A row out of sight holds the shapes of the secondary actions as they would stand, so
 * the answer is the same folded or not, and a change of language or of a label counts. The
 * shell's control, the primary action and the button of a menu the head has stay in the row
 * either way; they are measured where they stand. The row holds no button, so nothing a reader
 * or a test looks for in the head is in it twice.
 */
function useActionsFolded(): {
  head: RefObject<HTMLElement | null>;
  unfolded: RefObject<HTMLDivElement | null>;
  shell: RefObject<HTMLSpanElement | null>;
  primary: RefObject<HTMLSpanElement | null>;
  menu: RefObject<HTMLSpanElement | null>;
  folded: boolean;
  /**
   * The actions that never fold leave the name less than its least width beside them: they go
   * under the name, as they do in a narrow window.
   */
  crowded: boolean;
} {
  const head = useRef<HTMLElement>(null);
  const unfolded = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLSpanElement>(null);
  const primary = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const [folded, setFolded] = useState(false);
  const [crowded, setCrowded] = useState(false);
  useLayoutEffect(() => {
    const headNode = head.current;
    const row = unfolded.current;
    if (!headNode || typeof ResizeObserver === "undefined") {
      setFolded(false);
      setCrowded(false);
      return undefined;
    }
    const kept = [shell.current, primary.current, menu.current].filter((node) => node !== null);
    const measure = () => {
      const style = getComputedStyle(headNode);
      const room =
        headNode.clientWidth - pixels(style.paddingInlineStart) - pixels(style.paddingInlineEnd);
      const gap = pixels(getComputedStyle(row ?? kept[0]?.parentElement ?? headNode).columnGap);
      const keptWidth = kept.reduce(
        (width, node) => width + gap + node.getBoundingClientRect().width,
        0
      );
      // Half a pixel absorbs the rounding of scaled displays.
      setFolded(
        row !== null &&
          row.getBoundingClientRect().width + keptWidth + nameReserve(headNode, style) > room + 0.5
      );
      // Whether the kept actions leave the name its room is asked of the one-line head, also
      // once they went under the name: the answer does not change by its own effect.
      setCrowded(keptWidth + nameReserve(headNode, style, true) > room + 0.5);
    };
    measure();
    const observer = observeAFrameLater(
      [headNode, ...(row === null ? [] : [row]), ...kept],
      measure
    );
    return () => observer.disconnect();
  });
  return { head, unfolded, shell, primary, menu, folded, crowded };
}

// The width a detail head keeps for its name beside the actions, or the whole name where it is
// shorter: the actions fold before the name is cut to a few letters.
const NAME_LEAST = 160;

/**
 * The room a detail head's name needs beside the actions on one line: what stands before the
 * name, the way back without its text that gives way first, the name up to its least width,
 * and the gap to the actions. Where the head wraps, the actions take a line of their own and
 * the name needs none of theirs.
 */
function nameReserve(
  headNode: HTMLElement,
  style: CSSStyleDeclaration,
  /** The room asked of the head on one line, whether it wraps now or not. */
  oneLine = false
): number {
  const measure = headNode.querySelector<HTMLElement>("[data-name]");
  const name = measure?.parentElement;
  if (!measure || !name || (!oneLine && style.flexWrap === "wrap")) {
    return 0;
  }
  // The box of the way back's text: as wide as the text shows, nothing where it is gone.
  const backText = headNode.querySelector("[data-slot=page-header-back-text]")?.parentElement;
  const before =
    name.getBoundingClientRect().left -
    headNode.getBoundingClientRect().left -
    pixels(style.paddingInlineStart) -
    (backText?.getBoundingClientRect().width ?? 0);
  return Math.max(0, before) + Math.min(measure.scrollWidth, NAME_LEAST) + pixels(style.columnGap);
}

/** A length in pixels of a computed style, `0` where the style gives none. */
function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

function ActionButton({ action }: { action: PageHeaderAction }) {
  return (
    <Button
      variant="outline"
      loading={action.loading}
      disabled={action.disabled}
      onClick={action.onSelect}
    >
      {action.icon}
      {action.label}
    </Button>
  );
}

/** A secondary action's button in the measuring row: its shape and width, and no button. */
function ActionShape({ action }: { action: PageHeaderAction }) {
  return (
    <Button asChild variant="outline">
      <span>
        {action.icon}
        {action.label}
      </span>
    </Button>
  );
}

/** The head's "…": its menu's items, after the secondary actions that had no room in the row. */
function HeadMenu({
  folded,
  children
}: {
  folded: readonly PageHeaderAction[];
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <HeadMenuButton />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {folded.map((action) => (
          <DropdownMenuItem
            key={action.label}
            icon={action.icon}
            disabled={action.disabled === true || action.loading === true}
            onSelect={action.onSelect}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
        {folded.length > 0 && children !== undefined && children !== null ? (
          <DropdownMenuSeparator />
        ) : null}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const HeadMenuButton = forwardRef<HTMLButtonElement, HTMLAttributes<HTMLButtonElement>>(
  function HeadMenuButton(props, ref) {
    const labels = useUiLabels("PageHeader");
    return (
      <IconButton ref={ref} label={labels.moreActions} variant="outline" {...props}>
        <MoreHorizontal aria-hidden="true" />
      </IconButton>
    );
  }
);

/**
 * The head of a page. Its slots have one order on every page: back or breadcrumb, name, scope
 * chip, state, secondary actions, primary action, the "…" menu.
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
  secondaryActions = [],
  primaryAction,
  menu,
  ...props
}: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const detail = variant === "detail";
  const [row, backTextGone] = useBackTextGone();
  const shellAction = useContext(PageHeaderShellActionContext);
  const ownShellAction = headingLevel === 1 ? shellAction : null;
  const fold = useActionsFolded();
  const folded = fold.folded ? secondaryActions : [];
  const hasMenu = menu !== undefined && menu !== null;
  const hasActions =
    (ownShellAction !== null && ownShellAction !== undefined) ||
    secondaryActions.length > 0 ||
    primaryAction !== undefined ||
    hasMenu;
  const actions = hasActions ? (
    <div className="flex max-w-full shrink-0 items-center gap-2">
      {ownShellAction === null || ownShellAction === undefined ? null : (
        <span ref={fold.shell} className="flex shrink-0">
          {ownShellAction}
        </span>
      )}
      {fold.folded
        ? null
        : secondaryActions.map((action) => <ActionButton key={action.label} action={action} />)}
      {primaryAction === undefined ? null : (
        <span ref={fold.primary} className="flex shrink-0">
          {primaryAction}
        </span>
      )}
      {hasMenu || folded.length > 0 ? (
        // Where the head has a menu, its button stands in every state and counts as kept.
        <span ref={hasMenu ? fold.menu : undefined} className="flex shrink-0">
          <HeadMenu folded={folded}>{menu}</HeadMenu>
        </span>
      ) : null}
    </div>
  ) : null;
  // The secondary actions and the menu's button as the row would hold them, out of sight. The
  // box around them clips them, so they never widen the page.
  const unfoldedRow =
    secondaryActions.length === 0 ? null : (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-0 overflow-hidden"
      >
        <div ref={fold.unfolded} inert className="invisible flex w-max items-center gap-2">
          {secondaryActions.map((action) => (
            <ActionShape key={action.label} action={action} />
          ))}
        </div>
      </div>
    );
  if (detail) {
    return (
      <header
        data-variant={variant}
        // A `PageOutline` measures the pinned head: what it scrolls to rests below it.
        data-page-head=""
        ref={fold.head}
        className={cn(
          "sticky top-0 z-(--layer-sticky-header) flex min-h-(--layout-header) min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-background px-(--layout-gutter) py-1",
          // Beside a name that keeps its least width the actions stay on its line in a wide
          // window; where they would cut the name to a few letters, they go under it.
          fold.crowded ? undefined : "md:flex-nowrap",
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
          <div className="min-w-0">
            <Heading
              // An area puts the focus here when it opens; a title is no control and shows no
              // ring. Two lines of the name fit the head's height; a longer one is cut after the
              // second.
              className={cn("line-clamp-2 wrap-anywhere outline-none", "text-title")}
              title={typeof title === "string" ? title : undefined}
            >
              {title}
            </Heading>
            {typeof title === "string" ? (
              // The name on one line, unseen and without height: the row's least width stays the
              // whole name, so the actions wrap before the name does.
              <span
                aria-hidden="true"
                data-name={title}
                className="invisible block h-0 overflow-hidden text-title whitespace-nowrap before:content-[attr(data-name)]"
              />
            ) : null}
          </div>
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
        {unfoldedRow}
      </header>
    );
  }
  return (
    <header
      data-variant={variant}
      ref={fold.head}
      className={cn(
        "relative flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-6",
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
      {unfoldedRow}
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
    <div
      data-slot="page-header-description-room"
      className="@container flex min-w-0 flex-1 basis-0 items-baseline"
    >
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
