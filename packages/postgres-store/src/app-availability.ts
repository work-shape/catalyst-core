import { sql } from "drizzle-orm";
import type { AppAvailability } from "@work-shape/catalyst-core";
import { configAssets } from "./schema";

/** Apps use the existing availability. A private App selects exactly the publishing person's
 * personal workspace and marks that selection as personal; a workspace audience selects its
 * owner. The marker distinguishes the choices even when the owner is itself personal.
 * Existing Apps without availability retain their workspace audience. A lost private selection
 * grants nobody access. */
export const appAvailabilityColumn = sql<AppAvailability | null>`case when ${configAssets.kind} = 'app' then (
  select jsonb_strip_nulls(jsonb_build_object(
    'audience', case when a.mode = 'all' then 'instance'
      when a.asset_id is null then 'workspace'
      when a.personal_workspaces then 'self'
      when w.id = ${configAssets.scopeId} then 'workspace' else 'self' end,
    'userId', w.personal_user_id
  )) from (select 1) seed
  left join config_asset_availability a on a.asset_id = ${configAssets.id}
  left join lateral (
    select space.id, space.personal_user_id from config_asset_workspace_availability selected
    join collaboration_workspaces space on space.id = selected.collaboration_workspace_id
    where selected.asset_id = ${configAssets.id} limit 1
  ) w on true
) else null end`;
