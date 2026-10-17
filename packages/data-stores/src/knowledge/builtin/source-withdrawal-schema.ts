/** Forward-only owned-store migration. Item tombstones survive the purge for locate. */
export const SOURCE_WITHDRAWAL_SCHEMA = `
  alter table catalyst_kb.source_items add column parents jsonb not null default '[]', add column seen_run_id text;
  alter table catalyst_kb.sync_runs add column approval_request_id text, add column definition_key text;
  alter table catalyst_kb.source_cursors add column definition_key text;
  create index source_items_seen_idx on catalyst_kb.source_items(source_id,id) include(seen_run_id) where state<>'withdrawn';

  -- Project the old state while its document/content still exists. An AFTER DELETE
  -- projection would count a formerly indexed item as fetched and corrupt both counters.
  create function catalyst_kb.source_document_purged() returns trigger language plpgsql as $$
  begin
    -- A rediscovery can already own the item when its previous document is purged.
    -- Detach that document without cancelling the new fetch or its failure state.
    perform sha256 from catalyst_kb.contents where sha256=old.content_sha256 for share;
    update catalyst_kb.source_items set
      state=case when state='fetched' then 'withdrawn' else state end,
      failure_code=case when state='fetched' then null else failure_code end,
      document_id=null,
      fetch_job_id=case when state in ('fetched','withdrawn') then null else fetch_job_id end,
      withdrawn_at=case when state='fetched' then coalesce(withdrawn_at,now()) else withdrawn_at end,
      purged_at=case when state in ('fetched','withdrawn') then now() else null end
      where document_id=old.id;
    return old;
  end $$;
  create trigger source_document_purged before delete on catalyst_kb.documents for each row execute function catalyst_kb.source_document_purged();


  alter table catalyst_kb.source_items add column open_change_at timestamptz;
  create index source_items_open_change_idx on catalyst_kb.source_items(source_id,open_change_at,id) where open_change_at is not null;
  create function catalyst_kb.source_open_change() returns trigger language plpgsql as $$
  declare projected text;
  begin
    select state into projected from catalyst_kb.source_projection(new.state,new.document_id);
    new.open_change_at=case when projected in ('discovered','fetched') then new.changed_at end;
    return new;
  end $$;
  create trigger source_open_change before insert or update of state,document_id,changed_at on catalyst_kb.source_items for each row execute function catalyst_kb.source_open_change();
  update catalyst_kb.source_items i set open_change_at=i.changed_at
    where i.state='discovered' or (i.state='fetched' and exists(select 1 from catalyst_kb.documents d join catalyst_kb.contents c on c.sha256=d.content_sha256 where d.id=i.document_id and c.state='pending'));
  create function catalyst_kb.source_freshness_changed() returns trigger language plpgsql as $$
  begin
    update catalyst_kb.source_items i set open_change_at=case when new.state='pending' then i.changed_at end
      from catalyst_kb.documents d where i.document_id=d.id and d.content_sha256=new.sha256 and i.state='fetched';
    update catalyst_kb.source_cursors sc set oldest_open_change_at=(
      select min(i.open_change_at) from catalyst_kb.source_items i where i.source_id=sc.source_id and i.open_change_at is not null)
    where sc.source_id in (select i.source_id from catalyst_kb.source_items i join catalyst_kb.documents d on d.id=i.document_id where d.content_sha256=new.sha256);
    return null;
  end $$;
  create trigger source_freshness_changed after update of state on catalyst_kb.contents for each row execute function catalyst_kb.source_freshness_changed();
`;
