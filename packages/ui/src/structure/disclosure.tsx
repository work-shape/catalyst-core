import { Collapsible } from "radix-ui";
import { ChevronDown } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../cn";

/** `ghost` is a bare line that folds; `outline` frames the line and what it folds. */
export type DisclosureVariant = "ghost" | "outline";

export interface DisclosureProps extends HTMLAttributes<HTMLDivElement> {
  variant?: DisclosureVariant;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  disabled?: boolean;
}

/** Content that folds away under one line, such as advanced settings or a long value. */
export function Disclosure({ className, variant = "ghost", ...props }: DisclosureProps) {
  return (
    <Collapsible.Root
      data-variant={variant}
      className={cn(
        "group/disclosure w-full min-w-0",
        variant === "outline" && "rounded-md border py-3",
        className
      )}
      {...props}
    />
  );
}

export function DisclosureTrigger({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Collapsible.Trigger
      className={cn(
        "group/disclosure-trigger flex w-fit items-center gap-2 rounded-md py-1 text-left text-body text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50",
        "group-data-[variant=outline]/disclosure:w-full group-data-[variant=outline]/disclosure:px-4 group-data-[variant=outline]/disclosure:font-medium",
        className
      )}
      {...props}
    >
      <span className="min-w-0 group-data-[variant=outline]/disclosure:grow">{children}</span>
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
          "mt-1 flex flex-col gap-1",
          "group-data-[variant=outline]/disclosure:mt-3 group-data-[variant=outline]/disclosure:gap-2 group-data-[variant=outline]/disclosure:border-t group-data-[variant=outline]/disclosure:px-4 group-data-[variant=outline]/disclosure:pt-3"
        )}
      >
        {children}
      </div>
    </Collapsible.Content>
  );
}
