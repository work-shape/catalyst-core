import { useId, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { CopyButton } from "./copy-button";
import { FoldToggle, useFold } from "./folded-text";

/** `inline` puts the label beside the value; `stacked` puts it above. */
export type KeyValueLayout = "inline" | "stacked";

export interface KeyValueListProps extends HTMLAttributes<HTMLDListElement> {
  layout?: KeyValueLayout;
}

/** The list a set of `KeyValue` rows sits in. */
export function KeyValueList({ className, layout = "inline", ...props }: KeyValueListProps) {
  return (
    <dl
      data-layout={layout}
      className={cn("group/key-value grid min-w-0 gap-2", className)}
      {...props}
    />
  );
}

export interface KeyValueProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  /** Adds a copy button that puts this text on the clipboard. */
  copyValue?: string;
  /** Shows a long value on three lines with a control that unfolds it. */
  foldable?: boolean;
}

/** One labelled value, inside a `KeyValueList`. The value is the children. */
export function KeyValue({
  className,
  label,
  copyValue,
  foldable = false,
  children,
  ...props
}: KeyValueProps) {
  const valueId = useId();
  const fold = useFold<HTMLDivElement>(foldable);
  return (
    <div
      className={cn(
        "grid min-w-0 gap-x-3 gap-y-0.5 group-data-[layout=inline]/key-value:grid-cols-[7rem_minmax(0,1fr)] group-data-[layout=inline]/key-value:items-baseline",
        className
      )}
      {...props}
    >
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="grid min-w-0 justify-items-start gap-1 text-body">
        <div className="flex w-full min-w-0 items-start gap-1">
          <div
            ref={fold.ref}
            id={valueId}
            className={cn("min-w-0 flex-1 break-words", fold.folded && "line-clamp-3")}
          >
            {children}
          </div>
          {copyValue === undefined ? null : (
            <CopyButton value={copyValue} component="KeyValue" className="-my-1" />
          )}
        </div>
        {fold.long ? (
          <FoldToggle
            component="KeyValue"
            folded={fold.folded}
            controls={valueId}
            onToggle={fold.toggle}
          />
        ) : null}
      </dd>
    </div>
  );
}
