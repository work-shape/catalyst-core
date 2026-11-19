import { Collapsible } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { createContext, useContext, type ButtonHTMLAttributes, type HTMLAttributes } from "react";
import { cn } from "../cn";

/**
 * `ghost` is a bare line that folds; `outline` frames the line and what it folds; `row` is a
 * line as wide as its column with the arrow at its end, for a part of a page that stays folded.
 */
export type DisclosureVariant = "ghost" | "outline" | "row";

export interface DisclosureProps extends HTMLAttributes<HTMLDivElement> {
  variant?: DisclosureVariant;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  disabled?: boolean;
}

/**
 * The variant of the nearest Disclosure. Its line and its content read it here, not from an
 * ancestor's attribute: a bare one folded inside a `row` one keeps its own look.
 */
const DisclosureVariantContext = createContext<DisclosureVariant>("ghost");

/** Content that folds away under one line, such as advanced settings or a long value. */
export function Disclosure({ className, variant = "ghost", ...props }: DisclosureProps) {
  return (
    <DisclosureVariantContext.Provider value={variant}>
      <Collapsible.Root
        data-variant={variant}
        className={cn(
          "group/disclosure w-full min-w-0",
          variant === "outline" && "rounded-md border py-3",
          className
        )}
        {...props}
      />
    </DisclosureVariantContext.Provider>
  );
}

export function DisclosureTrigger({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const variant = useContext(DisclosureVariantContext);
  return (
    <Collapsible.Trigger
      className={cn(
        "group/disclosure-trigger flex w-fit items-center gap-2 rounded-md py-1 text-left text-body text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50",
        className,
        // What a variant sets of the line holds against the caller's classes, as it did while
        // the variant was read from the attribute: an outlined line keeps its inset.
        variant === "outline" && "w-full px-4 font-medium",
        variant === "row" && "w-full py-3"
      )}
      {...props}
    >
      <span className={cn("min-w-0", variant !== "ghost" && "grow")}>{children}</span>
      <ChevronDown
        aria-hidden="true"
        className="size-4 shrink-0 transition-transform duration-200 ease-out group-data-[state=closed]/disclosure-trigger:-rotate-90"
      />
    </Collapsible.Trigger>
  );
}

export interface DisclosureContentProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Keeps the folded content in the page, hidden, so what it reads is read while it is folded:
   * a question whose click waits for a list behind "Details" still waits for it.
   */
  keepMounted?: boolean;
}

export function DisclosureContent({
  className,
  children,
  keepMounted = false,
  ...props
}: DisclosureContentProps) {
  const variant = useContext(DisclosureVariantContext);
  return (
    <Collapsible.Content
      className={cn(
        "overflow-hidden text-body",
        // Radix renders forced content as open; a folded one is hidden here, by its state.
        keepMounted && "data-[state=closed]:hidden",
        className
      )}
      {...(keepMounted ? { forceMount: true } : {})}
      {...props}
    >
      <div
        className={cn(
          "flex flex-col",
          variant === "ghost" && "mt-1 gap-1",
          variant === "outline" && "mt-3 gap-2 border-t px-4 pt-3",
          variant === "row" && "mt-3 gap-0"
        )}
      >
        {children}
      </div>
    </Collapsible.Content>
  );
}
