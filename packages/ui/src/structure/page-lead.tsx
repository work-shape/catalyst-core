import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

/**
 * The paragraph that says what a page is about: the first thing in the page's body, under the
 * head and its tabs, in muted text. It keeps to two lines. A longer text ends in "Show more",
 * which opens the whole of it.
 */
export function PageLead({ className, children, ...props }: ComponentProps<"div">) {
  const labels = useUiLabels("PageLead");
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);

  useEffect(() => {
    const text = textRef.current;
    if (text === null || open) return;
    const measure = () => setCut(text.scrollHeight > text.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [open, children]);

  return (
    <div
      data-page-lead=""
      className={cn(
        "flex min-w-0 items-end gap-x-2 px-(--layout-gutter) pt-3 text-body text-muted-foreground",
        open && "flex-col items-start",
        className
      )}
      {...props}
    >
      <p
        ref={textRef}
        id={textId}
        className={cn("max-w-(--layout-content-narrow) min-w-0", !open && "line-clamp-2")}
      >
        {children}
      </p>
      {cut || open ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={textId}
          className="shrink-0 rounded-sm text-foreground underline-offset-4 hover:underline focus-visible:focus-ring"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? labels.showLess : labels.showMore}
        </button>
      ) : null}
    </div>
  );
}
