import { CircleAlert, CircleCheck } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export type FormNoticeTone = "error" | "success";

export interface FormNoticeProps extends HTMLAttributes<HTMLParagraphElement> {
  tone: FormNoticeTone;
}

/** The result of a save or a test, shown beside its button and announced when it appears. */
export function FormNotice({ tone, className, children, ...props }: FormNoticeProps) {
  return (
    <p
      role="status"
      data-tone={tone}
      className={cn(
        "flex items-start gap-1.5 text-body",
        tone === "error" ? "text-destructive-soft-foreground" : "text-success-soft-foreground",
        className
      )}
      {...props}
    >
      <span className="flex h-5 shrink-0 items-center">
        {tone === "error" ? (
          <CircleAlert aria-hidden="true" className="size-4" />
        ) : (
          <CircleCheck aria-hidden="true" className="size-4" />
        )}
      </span>
      <span>{children}</span>
    </p>
  );
}
