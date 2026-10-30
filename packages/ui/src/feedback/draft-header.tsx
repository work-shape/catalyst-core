import { Fragment, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { cn } from "../cn";
import type { UiLabels } from "../labels";
import { LinkSlot } from "../link-slot";
import { useUiLabels } from "../ui-root";
import { Banner } from "./banner";

/** An asset a draft calls that has a test target: its calls go there for real. */
export interface DraftTestTarget {
  /** The asset as people read it, such as a Data Store's title. */
  name: string;
  /** A Data Store's test copy, or a Connection's test credential. */
  kind: "copy" | "credential";
  /** The way to the test target, as the caller's link element, such as `<a href>`. */
  link?: ReactElement;
}

/** The revision that is live: its version, and who published it when, where that is known. */
export interface DraftLiveRevision {
  version: number;
  /** The name of who published it. */
  by?: string;
  /** When it was published, in words of the reader's language. */
  at?: string;
}

export interface DraftHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** The assets whose calls go to a test target, each named after the first line. */
  targets?: readonly DraftTestTarget[];
  /**
   * The live revision line. `null`: nothing is published yet. Absent: not known yet, and the
   * line is left out.
   */
  live?: DraftLiveRevision | null;
  /** What the draft changes against the live revision, under the live line. */
  changes?: ReactNode;
  /** What the reader may do with the draft, such as Test run and Publish. */
  action?: ReactNode;
}

function liveLine(live: DraftLiveRevision | null, labels: UiLabels): string {
  if (live === null) return labels.draftNotPublished;
  const key: keyof UiLabels =
    live.by !== undefined && live.at !== undefined
      ? "draftLiveByOn"
      : live.by !== undefined
        ? "draftLiveBy"
        : live.at !== undefined
          ? "draftLiveOn"
          : "draftLive";
  return labels[key]
    .replace("{version}", String(live.version))
    .replace("{name}", live.by ?? "")
    .replace("{date}", live.at ?? "");
}

/**
 * The head of a draft, under the page head of the App or the Workflow it belongs to. Its first
 * line says what a call of a draft does, "Draft · reads live data · changes are simulated",
 * and names each asset whose calls go to its test target instead ("Kunden: test copy"), with
 * the way to it. Under it stand the live revision, or that nothing is published yet, and what
 * the draft changes against it.
 */
export function DraftHeader({
  targets = [],
  live,
  changes,
  action,
  className,
  ...props
}: DraftHeaderProps) {
  const labels = useUiLabels("DraftHeader");
  return (
    <Banner
      layout="page"
      className={cn("shrink-0", className)}
      data-draft-header=""
      title={
        <>
          {labels.draftSimulates}
          {targets.map((target) => {
            const text = (
              target.kind === "copy" ? labels.draftTestCopy : labels.draftTestCredential
            ).replace("{name}", target.name);
            return (
              <Fragment key={`${target.kind}:${target.name}`}>
                <span aria-hidden="true">{" · "}</span>
                {target.link === undefined ? (
                  <span data-draft-test-target={target.kind}>{text}</span>
                ) : (
                  <LinkSlot
                    link={target.link}
                    data-draft-test-target={target.kind}
                    className="rounded-sm underline underline-offset-4 focus-visible:focus-ring"
                  >
                    {text}
                  </LinkSlot>
                )}
              </Fragment>
            );
          })}
        </>
      }
      action={action}
      {...props}
    >
      {live === undefined && changes === undefined ? undefined : (
        <div className="grid gap-0.5">
          {live === undefined ? null : <p data-draft-live="">{liveLine(live, labels)}</p>}
          {changes === undefined ? null : <div data-draft-changes="">{changes}</div>}
        </div>
      )}
    </Banner>
  );
}
