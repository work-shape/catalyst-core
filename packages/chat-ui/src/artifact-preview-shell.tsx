import type { ReactNode } from "react";
import { cn } from "./ui/cn";
import type { ArtifactFileType } from "./tool-artifacts";

export function ArtifactPreviewFrame({ children }: { children: ReactNode }) {
  return (
    <div className="-m-4 h-[calc(100%+2rem)] min-h-[34rem] bg-background lg:-m-5 lg:h-[calc(100%+2.5rem)]">
      {children}
    </div>
  );
}

export function ArtifactPreviewMessage({
  action,
  detail,
  fileType,
  title
}: {
  action?: ReactNode;
  detail?: string;
  fileType: ArtifactFileType;
  title: string;
}) {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <div className="max-w-sm rounded-md border bg-card px-4 py-3 text-sm shadow-xs">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-md text-xs font-bold text-white",
              fileType.className
            )}
            aria-hidden="true"
          >
            {fileType.badge}
          </span>
          <div className="min-w-0">
            <p className="font-medium">{title}</p>
            {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
            {action ? <div className="mt-3">{action}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
