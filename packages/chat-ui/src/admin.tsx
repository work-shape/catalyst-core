import type { ChatShellAdminPanel } from "./chat-shell";
import { canViewAdministrationPanel } from "./governance";
import { SuperadminPanel } from "./superadmin-panel";

export {
  canViewAdministrationPanel,
  canViewSuperadminPanel,
  canViewUsageGovernance
} from "./governance";
export { SuperadminPanel } from "./superadmin-panel";

export const superadminPanel: ChatShellAdminPanel = {
  canView: canViewAdministrationPanel,
  renderPanel: (props) => <SuperadminPanel {...props} />
};
