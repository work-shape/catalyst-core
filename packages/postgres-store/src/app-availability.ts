import { sql } from "drizzle-orm";
import type { AppAvailability } from "@work-shape/catalyst-core";
import { configAssets } from "./schema";

/** One indexed availability lookup and one indexed first-revision lookup per App. Existing
 * Apps without an availability retain their workspace audience. Personal availability means
 * the builder alone for an App; its immutable first revision supplies that person's id. */
export const appAvailabilityColumn = sql<AppAvailability | null>`case when ${configAssets.kind} = 'app' then (
  select jsonb_strip_nulls(jsonb_build_object(
    'audience', case when a.mode = 'all' then 'instance'
      when a.personal_workspaces then 'self' else 'workspace' end,
    'userId', (select coalesce(r.actor->>'subjectUserId', r.actor->>'userId')
      from config_asset_revisions r where r.asset_id = ${configAssets.id} and r.revision = 1)
  )) from (select 1) seed left join config_asset_availability a on a.asset_id = ${configAssets.id}
) else null end`;
