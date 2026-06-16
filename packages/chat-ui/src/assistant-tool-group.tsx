import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { ChevronDown } from "lucide-react";
import { useCallback, useState, type ComponentProps, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./ui/cn";
import { Spinner } from "./ui/spinner";

const toolGroupVariants = cva("aui-tool-group-root group/tool-group-root w-full", {
  variants: {
    variant: {
      ghost: "",
      muted: "rounded-md border border-muted-foreground/30 bg-muted/30 py-3",
      outline: "rounded-md border py-3"
    }
  },
  defaultVariants: {
    variant: "outline"
  }
});

export type ToolGroupRootProps = Omit<
  ComponentProps<typeof CollapsiblePrimitive.Root>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof toolGroupVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
  };

export function ToolGroupRoot({
  children,
  className,
  defaultOpen = false,
  onOpenChange: controlledOnOpenChange,
  open: controlledOpen,
  variant,
  ...props
}: ToolGroupRootProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      controlledOnOpenChange?.(nextOpen);
    },
    [controlledOnOpenChange, isControlled]
  );

  return (
    <CollapsiblePrimitive.Root
      data-slot="tool-group-root"
      data-variant={variant ?? "outline"}
      open={open}
      onOpenChange={onOpenChange}
      className={cn(toolGroupVariants({ variant }), className)}
      {...props}
    >
      {children}
    </CollapsiblePrimitive.Root>
  );
}

export function ToolGroupTrigger({
  active = false,
  children,
  className,
  count,
  label,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.Trigger> & {
  active?: boolean;
  count: number;
  label?: ReactNode;
}) {
  const resolvedLabel = label ?? `${count} tool ${count === 1 ? "call" : "calls"}`;

  return (
    <CollapsiblePrimitive.Trigger
      data-slot="tool-group-trigger"
      className={cn(
        "aui-tool-group-trigger group/trigger flex w-fit items-center gap-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
        "group-data-[variant=outline]/tool-group-root:w-full group-data-[variant=outline]/tool-group-root:px-4",
        "group-data-[variant=muted]/tool-group-root:w-full group-data-[variant=muted]/tool-group-root:px-4",
        className
      )}
      {...props}
    >
      {active ? <Spinner data-slot="tool-group-trigger-loader" size="md" /> : null}
      <span
        data-slot="tool-group-trigger-label"
        className={cn(
          "aui-tool-group-trigger-label-wrapper relative inline-block text-start leading-none font-medium",
          "group-data-[variant=ghost]/tool-group-root:font-normal",
          "group-data-[variant=outline]/tool-group-root:grow",
          "group-data-[variant=muted]/tool-group-root:grow"
        )}
      >
        <span>{resolvedLabel}</span>
        {active ? (
          <span
            aria-hidden="true"
            data-slot="tool-group-trigger-shimmer"
            className="aui-tool-group-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {resolvedLabel}
          </span>
        ) : null}
      </span>
      {children}
      <ChevronDown
        data-slot="tool-group-trigger-chevron"
        className={cn(
          "aui-tool-group-trigger-chevron size-4 shrink-0 transition-transform duration-200 ease-out",
          "group-data-[state=closed]/trigger:-rotate-90 group-data-[state=open]/trigger:rotate-0"
        )}
        aria-hidden="true"
      />
    </CollapsiblePrimitive.Trigger>
  );
}

export function ToolGroupContent({
  children,
  className,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return (
    <CollapsiblePrimitive.Content
      data-slot="tool-group-content"
      className={cn("aui-tool-group-content overflow-hidden text-sm outline-none", className)}
      {...props}
    >
      <div
        className={cn(
          "mt-2 flex flex-col gap-2",
          "group-data-[variant=ghost]/tool-group-root:mt-1 group-data-[variant=ghost]/tool-group-root:gap-1",
          "group-data-[variant=outline]/tool-group-root:mt-3 group-data-[variant=outline]/tool-group-root:border-t group-data-[variant=outline]/tool-group-root:px-4 group-data-[variant=outline]/tool-group-root:pt-3",
          "group-data-[variant=muted]/tool-group-root:mt-3 group-data-[variant=muted]/tool-group-root:border-t group-data-[variant=muted]/tool-group-root:px-4 group-data-[variant=muted]/tool-group-root:pt-3"
        )}
      >
        {children}
      </div>
    </CollapsiblePrimitive.Content>
  );
}
