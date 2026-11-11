import { IconTile, List, ListRow, RegistryIcon, Switch } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

/**
 * The group "Deine MCP-Server" of an agent's tools (PMCP-4): whether a run its person starts in
 * their own private chat is offered the tools of the MCP servers that person added for
 * themselves. No server is listed: they are each person's own, and nobody else sees them. On
 * unless the agent turns it off (`ownServers: false`).
 */
export function OwnServersRow({
  checked,
  disabled,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  const { t } = useTranslation();
  return (
    <List aria-label={t("configOwnServers")}>
      <ListRow
        data-tool-own-servers=""
        leading={
          <IconTile accent={checked}>
            <RegistryIcon name="connection" family="tool" />
          </IconTile>
        }
        title={t("configOwnServers")}
        description={t("configOwnServersText")}
        descriptionWraps
        actionsVisible
        actions={
          <Switch
            aria-label={t("configOwnServers")}
            checked={checked}
            disabled={disabled}
            onCheckedChange={onChange}
          />
        }
      />
    </List>
  );
}
