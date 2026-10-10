import {
  canEditConfigAssets,
  canManageApiAccess,
  canManageUsers,
  canViewAudit,
  canViewUsageGovernance
} from "../control-plane/governance";
import type { ChatShellAdministration } from "./page-definition";
import { AccessPage } from "./pages/access";
import { ApiAccessPage } from "./pages/api-access";
import { AuditPage } from "./pages/audit";
import { InfrastructurePage } from "./pages/infrastructure";
import { BuildPage } from "./pages/build";
import { JobsPage } from "./pages/jobs";
import { ModulesPage } from "./pages/modules";
import { UsagePage } from "./pages/usage";
import { UsersPage } from "./pages/users";

/**
 * The administration a host mounts: the Instance pages of Settings, one line per page in rail
 * order, and Config as the Build page. A new Instance page adds its file under `pages/` and
 * its line here.
 */
export const administration: ChatShellAdministration = {
  pages: [
    {
      id: "users",
      group: "instance",
      labelKey: "settings.users",
      visible: (viewer) => canManageUsers(viewer.user),
      component: UsersPage
    },
    {
      id: "access",
      group: "instance",
      labelKey: "settings.access",
      visible: (viewer) => canManageUsers(viewer.user),
      // The grant list has six columns.
      width: "wide",
      component: AccessPage
    },
    {
      id: "api-access",
      group: "instance",
      labelKey: "settings.apiAccess",
      visible: (viewer) => canManageApiAccess(viewer.user),
      component: ApiAccessPage
    },
    {
      id: "usage",
      group: "instance",
      labelKey: "settings.usage",
      width: "wide",
      visible: (viewer) => canViewUsageGovernance(viewer.user),
      component: UsagePage
    },
    {
      id: "audit",
      group: "instance",
      labelKey: "settings.audit",
      width: "wide",
      visible: (viewer) => canViewAudit(viewer.user),
      component: AuditPage
    },
    {
      id: "jobs",
      group: "instance",
      labelKey: "jobs.title",
      width: "wide",
      visible: (viewer) => canViewAudit(viewer.user),
      component: JobsPage
    },
    {
      id: "modules",
      group: "instance",
      labelKey: "modules.title",
      // The config key of a module stays on one line.
      width: "wide",
      visible: (viewer) => canViewAudit(viewer.user),
      component: ModulesPage
    },
    {
      id: "infrastructure",
      group: "instance",
      labelKey: "settings.infrastructure",
      // A row holds a provider, its region, its destination, its secrets and its health.
      width: "wide",
      visible: (viewer) => canManageUsers(viewer.user),
      component: InfrastructurePage
    }
  ],
  build: {
    labelKey: "nav.build",
    visible: (viewer) => canEditConfigAssets(viewer.user),
    component: BuildPage
  }
};
