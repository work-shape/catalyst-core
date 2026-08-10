import type { ChatShellAdminPanel } from "./chat-shell";
import { resolveAdministrationRoute, SuperadminPanel } from "./control-plane/superadmin-panel";

export {
  canEditConfigAssets,
  canManageApiAccess,
  canManageUsers,
  canViewAudit,
  canViewAdministrationPanel,
  canViewSuperadminPanel,
  canViewUsageGovernance
} from "./control-plane/governance";
export { SuperadminPanel } from "./control-plane/superadmin-panel";

export const superadminPanel: ChatShellAdminPanel = {
  resolveRoute: resolveAdministrationRoute,
  Panel: SuperadminPanel
};
