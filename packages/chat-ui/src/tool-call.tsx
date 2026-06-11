import { CheckCircle2, CircleAlert, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

interface ToolCallPartProps {
  toolName: string;
  toolCallId: string;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
}

interface DataPartProps {
  name: string;
  data: unknown;
}

export function ToolCallPart({ toolName, toolCallId, argsText, result, isError }: ToolCallPartProps) {
  const { t } = useTranslation();
  const state = isError ? "failed" : result === undefined ? "running" : "completed";
  const Icon = state === "running" ? Loader2 : state === "failed" ? CircleAlert : CheckCircle2;
  const details = formatDetails(result ?? argsText);

  return (
    <div
      className={cn(
        "my-2 max-w-3xl rounded-md border bg-card shadow-xs",
        state === "failed" && "border-destructive/40 bg-destructive/5"
      )}
      data-testid="tool-call-card"
    >
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {state === "running" ? (
            <Icon className="animate-spin" size={15} aria-hidden="true" />
          ) : (
            <Icon size={15} aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{toolName}</p>
          <p className="truncate text-xs text-muted-foreground">{toolStatusLabel(state, t)}</p>
        </div>
        <Wrench size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
      {details ? (
        <details className="group/tool text-xs" open={state === "failed"}>
          <summary className="cursor-pointer px-3 py-2 text-muted-foreground outline-none transition-colors hover:text-foreground">
            {t("toolDetails")}
          </summary>
          <pre className="max-h-56 overflow-auto border-t bg-muted/50 px-3 py-2 font-mono text-[0.75rem] leading-5 [overflow-wrap:anywhere]">
            {details}
          </pre>
        </details>
      ) : null}
      <span className="sr-only">{toolCallId}</span>
    </div>
  );
}

export function DataPart({ name, data }: DataPartProps) {
  const { t } = useTranslation();
  const details = formatDetails(data);
  return (
    <div className="my-2 max-w-3xl rounded-md border bg-card px-3 py-2 text-sm shadow-xs">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Wrench size={14} aria-hidden="true" />
        <span>{t("structuredOutput", { name })}</span>
      </div>
      {details ? (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
          {details}
        </pre>
      ) : null}
    </div>
  );
}

function toolStatusLabel(
  state: "running" | "completed" | "failed",
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (state === "running") {
    return t("toolRunning");
  }
  if (state === "failed") {
    return t("toolFailed");
  }
  return t("toolCompleted");
}

function formatDetails(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
