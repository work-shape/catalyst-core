import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { Spinner } from "../feedback/spinner";

export interface ThumbnailButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title" | "aria-label"
> {
  /** What a press does, with the picture's name: "Open preview for photo.png". */
  label: string;
  /** The line under the picture, such as its file name. */
  caption?: ReactNode;
  /** Shows a spinner over the picture and disables the button while what it opens loads. */
  loading?: boolean;
  /** The picture: an image, or what stands in for it while it cannot be shown. */
  children: ReactNode;
}

/**
 * A small picture with its caption on a framed card that is a button, such as an image sent
 * with a message that opens in the preview. The caller decides what pressing it does.
 */
export const ThumbnailButton = forwardRef<HTMLButtonElement, ThumbnailButtonProps>(
  function ThumbnailButton(
    { label, caption, loading = false, className, children, ...props },
    ref
  ) {
    return (
      <button
        ref={ref}
        {...props}
        type={props.type ?? "button"}
        title={label}
        aria-label={label}
        aria-busy={loading}
        disabled={props.disabled || loading}
        className={cn(
          "relative grid max-w-full cursor-zoom-in gap-1 overflow-hidden rounded-md border bg-card p-1 text-left shadow-xs transition-colors",
          "hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
          loading && "cursor-progress",
          className
        )}
      >
        {children}
        {caption === undefined ? null : (
          <span className="truncate px-1 pb-1 text-xs text-muted-foreground">{caption}</span>
        )}
        {loading ? (
          <span className="absolute inset-0 grid place-items-center bg-background/50">
            <Spinner size="sm" />
          </span>
        ) : null}
      </button>
    );
  }
);
