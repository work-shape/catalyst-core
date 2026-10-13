import { Button } from "@vivd-catalyst/ui";
import { opensHere } from "./apps/app-header";
import { workspaceRoutePath } from "./routes";
import type { WorkspaceRoute } from "./workspace/workspace-route";

/**
 * A link to a place of the workspace that reads as a button: the main action of a card, or a
 * quiet way to where the thing is edited. A plain click opens the place here; any other click
 * is the browser's.
 */
export function RouteLink({
  route,
  variant,
  size = "sm",
  describedBy,
  onOpen,
  children
}: {
  route: WorkspaceRoute;
  variant: "primary" | "link";
  size?: "sm" | "md";
  /** The id of what the link acts on, where its text alone does not say it. */
  describedBy?: string;
  onOpen(route: WorkspaceRoute): void;
  children: string;
}) {
  return (
    <Button variant={variant} size={size} asChild>
      <a
        href={workspaceRoutePath(route)}
        aria-describedby={describedBy}
        onClick={(event) => {
          if (opensHere(event)) {
            event.preventDefault();
            onOpen(route);
          }
        }}
      >
        {children}
      </a>
    </Button>
  );
}
