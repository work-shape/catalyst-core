import { Button, IconButton, type PageHeaderAction } from "@work-shape/catalyst-ui";

/**
 * "Edit with the agent" in the head of an asset's page. It stays in the row however narrow the
 * page is: its words where there is room, its icon alone on a phone and beside the dock, where
 * the head's other secondary actions fold into "…". The dock that opens is the way to the
 * agent, so the action stays in sight to bring it back.
 */
export function HeadAgentAction({ action }: { action: PageHeaderAction }) {
  return (
    <span data-head-agent-action="" className="flex shrink-0">
      <Button
        variant="outline"
        loading={action.loading}
        disabled={action.disabled}
        className="max-md:hidden @max-2xl/dock-page:hidden"
        onClick={action.onSelect}
      >
        {action.icon}
        {action.label}
      </Button>
      <IconButton
        label={action.label}
        variant="outline"
        size="lg"
        disabled={action.disabled === true || action.loading === true}
        className="hidden max-md:inline-flex @max-2xl/dock-page:inline-flex"
        onClick={action.onSelect}
      >
        {action.icon}
      </IconButton>
    </span>
  );
}
