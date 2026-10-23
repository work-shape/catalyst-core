import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn";
import { Skeleton } from "../feedback/skeleton";
import { TargetBadge } from "../status/target-badge";
import { useUiLabels } from "../ui-root";
import { FoldToggle } from "./folded-text";

/** One recipient as a mail preview names it: a person or workspace by name, an address. */
export interface MailPreviewRecipient {
  label: string;
  /**
   * A value a step gives when it runs, such as an address list of an earlier result: drawn as a
   * chip, since nobody knows its addresses before the run.
   */
  picked?: boolean;
}

export type MailPreviewState = "empty" | "loading" | "rendered";

export interface MailPreviewProps {
  state?: MailPreviewState;
  /** Whom the mail goes out as: the sender's name and address, and its icon. */
  from?: { name: string; address?: string; icon?: ReactNode };
  to?: readonly MailPreviewRecipient[];
  cc?: readonly MailPreviewRecipient[];
  bcc?: readonly MailPreviewRecipient[];
  /** The subject as text, or with the chips of the values a step puts in. */
  subject?: ReactNode;
  /**
   * The body as the server rendered it, a whole HTML document. It is drawn in a sandboxed frame
   * that runs no script and loads nothing from elsewhere, and takes no input.
   */
  html?: string;
  /** The body as the caller draws it, where no rendered HTML is given. */
  children?: ReactNode;
  /** The instance's frame around the body: its name and mark, in its accent colour. */
  brand?: { name: string; mark?: ReactNode };
  /** Under the body, such as who sent the mail automatically. */
  footer?: ReactNode;
  /** The mail was not sent: a test run simulated it. */
  simulated?: boolean;
  /**
   * A test mail, which went to the tester alone: "[Test]" before the subject and the recipients
   * it would have reached.
   */
  test?: { to: readonly MailPreviewRecipient[]; cc?: readonly MailPreviewRecipient[] };
  /** How many lines of the body show before "Show more". Without it the body shows whole. */
  foldLines?: number;
  /** Names the preview for assistive technology and titles the frame of the rendered body. */
  label: string;
  className?: string;
}

/** The CSP of the frame: nothing but the mail's own inline styles and embedded pictures. */
const FRAME_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; font-src data:; form-action 'none'";

/**
 * The document the frame draws: the server's HTML with a policy in front that refuses every
 * load from elsewhere, so a picture or a style sheet of a remote host stays unloaded.
 */
function framedDocument(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><meta name="referrer" content="no-referrer">`;
  return /<head[^>]*>/iu.test(html)
    ? html.replace(/<head[^>]*>/iu, (head) => `${head}${policy}`)
    : `<!doctype html><html><head>${policy}</head><body>${html}</body></html>`;
}

function Recipients({ list }: { list: readonly MailPreviewRecipient[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {list.map((recipient, index) => (
        <span
          // Recipients have no id of their own; the order of the list does not change.
          key={`${index}:${recipient.label}`}
          data-mail-recipient={recipient.picked ? "picked" : ""}
          className={cn(
            "inline-flex max-w-full items-center rounded-full border px-2 text-caption",
            recipient.picked
              ? "border-primary-border bg-primary-soft text-primary-soft-foreground"
              : "text-foreground"
          )}
        >
          <span className="truncate">{recipient.label}</span>
        </span>
      ))}
    </span>
  );
}

function Row({ label, children, field }: { label: string; children: ReactNode; field: string }) {
  return (
    <div
      className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2"
      data-mail-row={field}
    >
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-body wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * The server's rendered body in a frame that runs no script, loads nothing and takes no click:
 * its height follows the document, which the frame shares its origin with only to measure it.
 */
function RenderedBody({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();
  const measure = useCallback(() => {
    const document = frame.current?.contentDocument;
    const next = document?.documentElement.scrollHeight;
    if (next !== undefined && next > 0) setHeight(next);
  }, []);
  return (
    <iframe
      ref={frame}
      title={title}
      data-mail-frame=""
      // No script, form, popup or navigation. The origin is shared only to measure the height.
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={framedDocument(html)}
      onLoad={measure}
      tabIndex={-1}
      className="pointer-events-none block w-full border-0 bg-background"
      style={{ height: height ?? 240 }}
    />
  );
}

/**
 * An e-mail as it goes out or went out: who sends it to whom, its subject, and its body in the
 * instance's frame. A rendered body comes only from the server and is drawn in a sandboxed
 * frame; a body the caller draws stands in the same place. It shows a mail and edits nothing.
 */
export function MailPreview({
  state = "rendered",
  from,
  to = [],
  cc = [],
  bcc = [],
  subject,
  html,
  children,
  brand,
  footer,
  simulated = false,
  test,
  foldLines,
  label,
  className
}: MailPreviewProps) {
  const labels = useUiLabels("MailPreview");
  const bodyId = useId();
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const folded = foldLines !== undefined && !expanded;

  useEffect(() => {
    const node = body.current;
    if (!folded || !node || typeof ResizeObserver === "undefined") return;
    const measure = () => setLong(node.scrollHeight > node.clientHeight + 1);
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(node);
    for (const child of Array.from(node.children)) resized.observe(child);
    return () => resized.disconnect();
  }, [folded, html, children]);

  if (state === "loading") {
    return (
      <section
        aria-label={label}
        aria-busy="true"
        data-mail-preview="loading"
        className={cn("grid gap-3 rounded-lg border bg-card p-4", className)}
      >
        <Skeleton className="w-1/2" />
        <Skeleton className="w-1/3" />
        <Skeleton className="h-24 w-full rounded-md" />
      </section>
    );
  }
  if (state === "empty") {
    return (
      <section
        aria-label={label}
        data-mail-preview="empty"
        className={cn(
          "grid min-h-24 place-items-center rounded-lg border border-dashed border-input-strong p-4 text-caption text-muted-foreground",
          className
        )}
      >
        {labels.mailEmpty}
      </section>
    );
  }

  return (
    <section
      aria-label={label}
      data-mail-preview={test ? "test" : simulated ? "simulated" : "rendered"}
      className={cn(
        "grid min-w-0 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-raised",
        className
      )}
    >
      <div className="grid gap-2 border-b px-4 py-3">
        <dl className="grid gap-1.5">
          {from === undefined ? null : (
            <Row label={labels.mailFrom} field="from">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {from.icon === undefined ? null : (
                  <span className="inline-flex shrink-0 text-muted-foreground [&_svg]:size-4">
                    {from.icon}
                  </span>
                )}
                <span className="font-medium">{from.name}</span>
                {from.address === undefined ? null : (
                  <span className="text-muted-foreground">{`<${from.address}>`}</span>
                )}
              </span>
            </Row>
          )}
          {to.length === 0 ? null : (
            <Row label={labels.mailTo} field="to">
              <Recipients list={to} />
            </Row>
          )}
          {cc.length === 0 ? null : (
            <Row label={labels.mailCc} field="cc">
              <Recipients list={cc} />
            </Row>
          )}
          {bcc.length === 0 ? null : (
            <Row label={labels.mailBcc} field="bcc">
              <Recipients list={bcc} />
            </Row>
          )}
          {subject === undefined ? null : (
            <Row label={labels.mailSubject} field="subject">
              <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-medium">
                {test === undefined ? null : (
                  <span className="text-muted-foreground">{labels.mailTestPrefix}</span>
                )}
                <span className="min-w-0">{subject}</span>
              </span>
            </Row>
          )}
        </dl>
        {simulated || test ? (
          <div className="flex gap-1.5">
            <TargetBadge target={test ? "test" : "dry_run"} />
          </div>
        ) : null}
      </div>
      {test === undefined ? null : (
        <div
          data-mail-test=""
          className="grid gap-1.5 border-b bg-info-soft px-4 py-2 text-info-soft-foreground"
        >
          <span className="text-caption font-medium">{labels.mailTestIntended}</span>
          <Recipients list={[...test.to, ...(test.cc ?? [])]} />
        </div>
      )}
      <div className="grid min-w-0 bg-background">
        {brand === undefined ? null : (
          <div
            data-mail-brand=""
            className="flex items-center gap-2 border-t-4 border-t-primary px-4 pt-3 pb-2 text-label"
          >
            {brand.mark === undefined ? null : (
              <span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-sm [&_img]:size-full [&_img]:object-contain [&_svg]:size-5">
                {brand.mark}
              </span>
            )}
            <span className="truncate">{brand.name}</span>
          </div>
        )}
        <div
          ref={body}
          id={bodyId}
          data-mail-body=""
          className={cn(
            "relative min-w-0",
            html === undefined && "px-4 py-3",
            folded && "overflow-hidden"
          )}
          style={folded ? { maxHeight: `${foldLines * 1.5}rem` } : undefined}
        >
          {html === undefined ? children : <RenderedBody html={html} title={label} />}
        </div>
        {foldLines !== undefined && (long || expanded) ? (
          <div className="px-4 pb-2">
            <FoldToggle
              component="MailPreview"
              folded={folded}
              controls={bodyId}
              onToggle={() => setExpanded((value) => !value)}
            />
          </div>
        ) : null}
        {footer === undefined ? null : (
          <div
            data-mail-footer=""
            className="border-t px-4 py-2 text-caption text-muted-foreground"
          >
            {footer}
          </div>
        )}
      </div>
    </section>
  );
}
