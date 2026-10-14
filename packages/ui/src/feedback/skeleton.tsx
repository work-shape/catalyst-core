import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

export type SkeletonShape = "line" | "block" | "circle";

const skeletonShapes: Record<SkeletonShape, string> = {
  line: "h-3 w-full rounded-sm",
  block: "h-24 w-full rounded-md",
  circle: "size-8 rounded-full"
};

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** The caller sets width and height with `className` where the default does not fit. */
  shape?: SkeletonShape;
}

/** A grey stand-in for one piece of content that is loading. */
export function Skeleton({ shape = "line", className, ...props }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block animate-pulse bg-state-pressed motion-reduce:animate-none",
        skeletonShapes[shape],
        className
      )}
      {...props}
    />
  );
}

export interface SkeletonListProps extends HTMLAttributes<HTMLDivElement> {
  rows?: number;
}

/** The loading layout of a list: rows with a mark, a name and a second line. */
export function SkeletonList({ rows = 4, ...props }: SkeletonListProps) {
  return (
    <LoadingLayout {...props}>
      <div className="grid">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex h-11 items-center gap-3 border-b last:border-b-0">
            <Skeleton shape="circle" />
            <div className="grid min-w-0 flex-1 gap-2">
              <Skeleton className="w-1/3" />
              <Skeleton className="w-1/2" />
            </div>
            <Skeleton className="w-16" />
          </div>
        ))}
      </div>
    </LoadingLayout>
  );
}

export interface SkeletonChipsProps extends HTMLAttributes<HTMLDivElement> {
  chips?: number;
}

/** The loading layout of a row of chips, such as an agent's skills or tools, with the picker below. */
export function SkeletonChips({ chips = 3, ...props }: SkeletonChipsProps) {
  return (
    <LoadingLayout {...props}>
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: chips }, (_, chip) => (
            <Skeleton key={chip} className="h-6 w-24 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-9 w-full max-w-120 rounded-md" />
      </div>
    </LoadingLayout>
  );
}

export interface SkeletonPageProps extends HTMLAttributes<HTMLDivElement> {
  sections?: number;
}

/** The loading layout of an asset page: a header and sections. */
export function SkeletonPage({ sections = 2, ...props }: SkeletonPageProps) {
  return (
    <LoadingLayout {...props}>
      <div className="grid gap-8">
        <div className="flex items-center gap-3">
          <Skeleton shape="circle" className="size-10" />
          <div className="grid min-w-0 flex-1 gap-2">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="w-2/5" />
          </div>
        </div>
        {Array.from({ length: sections }, (_, section) => (
          <div key={section} className="grid gap-3">
            <Skeleton className="h-3.5 w-1/5" />
            <Skeleton shape="block" />
          </div>
        ))}
      </div>
    </LoadingLayout>
  );
}

/**
 * Tells assistive technology once that content is loading; the shapes inside stay silent.
 *
 * The layout holds its room from the start and shows itself after `--duration-loading-delay`,
 * so content that arrives sooner replaces nothing the reader saw.
 */
function LoadingLayout({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const labels = useUiLabels("Skeleton");
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn("animate-loading-appear", className)}
      {...props}
    >
      <span className="sr-only">{labels.loading}</span>
      {children}
    </div>
  );
}
