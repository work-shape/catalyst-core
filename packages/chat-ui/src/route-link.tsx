import type { AnchorHTMLAttributes } from "react";
import { Button } from "@vivd-catalyst/ui";
import { opensHere } from "./apps/app-header";
import { workspaceRoutePath } from "./routes";
import type { WorkspaceRoute } from "./workspace/workspace-route";

interface RouteLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "onClick" | "children" | "aria-describedby"
> {
  route: WorkspaceRoute;
  variant: "primary" | "link";
  size?: "sm" | "md";
  /** The id of what the link acts on, where its text alone does not say it. */
  describedBy?: string;
  onOpen(route: WorkspaceRoute): void;
  children: string;
}

/**
 * A link to a place of the workspace that reads as a button: the main action of a card, or a
 * quiet way to where the thing is edited. A plain click opens the place here; any other click
 * is the browser's. Further props, such as those a `CardTarget` gives, reach the link element.
 */
export function RouteLink({
  route,
  variant,
  size = "sm",
  describedBy,
  onOpen,
  className,
  children,
  ...props
}: RouteLinkProps) {
  return (
    <Button variant={variant} size={size} className={className} asChild>
      <a
        {...props}
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
