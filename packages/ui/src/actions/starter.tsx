import {
  Children,
  createContext,
  forwardRef,
  useContext,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { Button } from "./button";

/** Whether the starters of a list stand as short cards: an icon and a title, no hint. */
const CompactStartersContext = createContext(false);

/** Above this many, a list's starters stand as short cards in more columns. */
const ROOMY_STARTERS_MAX = 4;

export interface StarterProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** What the starter begins, in a few words. */
  title: ReactNode;
  /** One short line under the title. A list of more than four starters leaves it out. */
  hint?: ReactNode;
  /** The icon of what the starter draws on, such as a skill's. It repeats nothing a reader needs. */
  icon?: ReactNode;
}

/**
 * One first request a person can begin with: an icon, a title and a hint on a card that is a
 * button. The caller decides what choosing it does.
 */
export const Starter = forwardRef<HTMLButtonElement, StarterProps>(function Starter(
  { title, hint, icon, className, ...props },
  ref
) {
  const compact = useContext(CompactStartersContext);
  return (
    <button
      ref={ref}
      {...props}
      type={props.type ?? "button"}
      className={cn(
        "flex min-w-0 items-center rounded-lg border bg-card text-left transition-colors hover:border-input-strong hover:bg-state-hover focus-visible:focus-ring active:bg-state-pressed disabled:pointer-events-none disabled:opacity-50",
        compact ? "gap-2.5 px-2.5 py-2" : "gap-3 px-3 py-2.5",
        className
      )}
    >
      {icon === undefined ? null : <span className="flex shrink-0 items-center">{icon}</span>}
      <span className="grid min-w-0 gap-0.5">
        {/* A short card is narrow, so its title may take a second line. */}
        <span className={cn(compact ? "line-clamp-2 break-words" : "truncate", "text-label")}>
          {title}
        </span>
        {hint === undefined || compact ? null : (
          <span className="truncate text-caption text-muted-foreground">{hint}</span>
        )}
      </span>
    </button>
  );
});

export interface StarterListProps {
  /** What the starters are, for assistive technology: "Suggestions to start with". */
  label: string;
  children: ReactNode;
  /**
   * The words of the button that shows the starters after the first nine, and of the one that
   * hides them again: "More" and "Fewer". Without them a long list shows whole.
   */
  more?: { show: string; hide: string };
  className?: string;
}

/** How many starters a long list shows before "More": three rows of three where it is wide. */
const FOLDED_STARTERS = 9;

/**
 * Starters side by side. Up to four stand in two columns, one column where the room is narrow,
 * each with its hint. More than four stand as short cards without hints, in two columns and
 * three where the room is wide; with `more`, the first nine show and a quiet button shows the
 * rest. The list's own width decides the columns, not the window's: in a dock beside a page it
 * keeps the narrow layout at any window. Every starter of a list stands as high as the highest,
 * so one without a hint or an icon looks like the others.
 */
export function StarterList({ label, children, more, className }: StarterListProps) {
  const starters = Children.toArray(children);
  const compact = starters.length > ROOMY_STARTERS_MAX;
  const folds = more !== undefined && starters.length > FOLDED_STARTERS;
  const [unfolded, setUnfolded] = useState(false);
  const gridId = useId();
  return (
    <div
      role="group"
      aria-label={label}
      data-starters={compact ? "compact" : "roomy"}
      className={cn("@container/starters grid w-full min-w-0 gap-2", className)}
    >
      <CompactStartersContext value={compact}>
        <div
          id={gridId}
          className={cn(
            "grid auto-rows-fr gap-2",
            compact
              ? "grid-cols-2 @[40rem]/starters:grid-cols-3"
              : "@[32.5rem]/starters:grid-cols-2"
          )}
        >
          {folds && !unfolded ? starters.slice(0, FOLDED_STARTERS) : starters}
        </div>
      </CompactStartersContext>
      {folds ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={unfolded}
          aria-controls={gridId}
          className="justify-self-center text-muted-foreground"
          onClick={() => setUnfolded((shown) => !shown)}
        >
          {unfolded ? more.hide : more.show}
        </Button>
      ) : null}
    </div>
  );
}
