import { Banner, type BannerLayout } from "@work-shape/catalyst-ui";
import type { RefusalAction } from "../shared/i18n/refusals";
import type { WorkspaceRoute } from "../shared/workspace-route";
import { RouteLink } from "./route-link";

/**
 * A refusal in the row where it was met, with the way to what it names beside it (REFUSE-1).
 * The way is offered only where the place can open it: without `onOpen` the sentence stands
 * alone.
 */
export function RefusalNotice({
  message,
  action,
  onOpen,
  layout = "inline",
  className
}: {
  message: string;
  action?: RefusalAction | undefined;
  onOpen?: ((route: WorkspaceRoute) => void) | undefined;
  /** `page` under a page's head, `inline` in a dialog or a row. */
  layout?: Extract<BannerLayout, "inline" | "page">;
  className?: string;
}) {
  return (
    <Banner
      tone="danger"
      layout={layout}
      className={className}
      data-testid="refusal-notice"
      action={
        action && onOpen ? (
          <RouteLink route={action.route} variant="link" onOpen={onOpen}>
            {action.label}
          </RouteLink>
        ) : undefined
      }
    >
      {message}
    </Banner>
  );
}
