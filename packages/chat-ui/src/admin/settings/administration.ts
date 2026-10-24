import {
  canManageApiAccess,
  canManageServicePrincipals,
  canManageSpendLimits,
  canManageUsers,
  canViewAudit,
  canViewSystem,
  canViewUsageGovernance
} from "../../shared/governance";
import type { ChatShellAdministration } from "../../shared/page-definition";
import { AccessPage } from "./pages/access";
import { ApiAccessPage } from "./pages/api-access";
import { AuditPage } from "./pages/audit";
import { InfrastructurePage } from "./pages/infrastructure";
import { resolveBuildRights } from "../../shared/build-rights";
import { BuildPage } from "./pages/build";
import { JobsPage } from "./pages/jobs";
import { LimitsPage } from "./pages/limits";
import { ModulesPage } from "./pages/modules";
import { OperationsPage } from "./pages/operations";
import { UsagePage } from "./pages/usage";
import { UsersPage } from "./pages/users";
import { WorkspacesPage } from "./pages/workspaces";

/**
 * The administration a host mounts: the Instance pages of Settings, one line per page in rail
 * order with the System pages last, and Config as the Build page. A new Instance page adds its file under `pages/` and
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
      visible: (viewer) =>
        canManageServicePrincipals(viewer.platform) || canManageApiAccess(viewer.user),
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
      id: "limits",
      group: "instance",
      labelKey: "settings.limits",
      visible: (viewer) => canManageSpendLimits(viewer.platform),
      component: LimitsPage
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
      id: "workspaces",
      group: "instance",
      labelKey: "settings.workspaces",
      visible: (viewer) => canManageUsers(viewer.user),
      component: WorkspacesPage
    },
    // The group "System" at the end of Instance, folded: how the instance runs, for who runs
    // it and never for a customer's admin by default (RIGHTS-1e; UX audit ruling 2).
    {
      id: "jobs",
      group: "instance",
      system: true,
      labelKey: "jobs.title",
      width: "wide",
      visible: (viewer) => canViewSystem(viewer.platform),
      component: JobsPage
    },
    {
      id: "operations",
      group: "instance",
      system: true,
      labelKey: "operations.title",
      width: "wide",
      visible: (viewer) => canViewSystem(viewer.platform),
      component: OperationsPage
    },
    {
      id: "modules",
      group: "instance",
      system: true,
      labelKey: "modules.title",
      // The config key of a module stays on one line.
      width: "wide",
      visible: (viewer) => canViewSystem(viewer.platform),
      component: ModulesPage
    },
    {
      id: "infrastructure",
      group: "instance",
      system: true,
      labelKey: "settings.infrastructure",
      // A row holds a provider, its region, its destination, its secrets and its health.
      width: "wide",
      visible: (viewer) => canViewSystem(viewer.platform),
      component: InfrastructurePage
    }
  ],
  build: {
    labelKey: "nav.build",
    visible: (viewer) => resolveBuildRights(viewer.user, viewer.platform).readsAny,
    component: BuildPage
  }
};
