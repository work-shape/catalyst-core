/**
 * Installed only under the store's schema-setup lock. The body cannot be replaced by the
 * app role: it has no CREATE on catalyst. Its owner can still ALTER function flags, so the
 * body itself refuses an unexpected identity or search path before executing customer SQL.
 * This also fails closed if a concurrent trigger changes SECURITY DEFINER to INVOKER.
 */
export const RECORD_PROJECTION_SCHEMA = `
  do $setup$
  declare
    app text := current_setting('catalyst.records_app_role');
    platform text := current_user;
    can_set boolean := pg_catalog.pg_has_role(current_user, app::name, 'SET');
    own_grant boolean := exists (
      select 1 from pg_catalog.pg_auth_members m
      where m.roleid = (select oid from pg_catalog.pg_roles where rolname = app)
        and m.member = (select oid from pg_catalog.pg_roles where rolname = current_user)
        and m.grantor = (select oid from pg_catalog.pg_roles where rolname = current_user)
    );
  begin
    if not can_set then
      execute pg_catalog.format('grant %I to %I with set true%s granted by %I',
        app, platform, case when own_grant then '' else ', inherit false, admin false' end, platform);
    end if;
    execute pg_catalog.format('grant create on schema catalyst to %I', app);
    execute pg_catalog.format('set local role %I', app);
    execute pg_catalog.format($definition$
      create or replace function catalyst.project_record(command_text text, row_data jsonb)
        returns table(inserted integer, updated integer)
        language plpgsql security definer set search_path = pg_catalog as $projection$
        begin
          if current_user <> %L or pg_catalog.current_setting('search_path') <> 'pg_catalog' then
            raise exception using errcode = '42501', message = 'Records projection frame needs its upgrade';
          end if;
          if command_text is null then
            set constraints all immediate;
            return query select 0,0;
          else
            return query execute command_text using row_data;
          end if;
        end $projection$;
    $definition$, app);
    revoke all on function catalyst.project_record(text,jsonb) from public;
    execute pg_catalog.format('grant execute on function catalyst.project_record(text,jsonb) to %I', platform);
    reset role;
    execute pg_catalog.format('revoke create on schema catalyst from %I', app);
    if not can_set then
      if own_grant then
        execute pg_catalog.format('grant %I to %I with set false granted by %I', app, platform, platform);
      else
        execute pg_catalog.format('revoke %I from %I granted by %I', app, platform, platform);
      end if;
    end if;
  end $setup$;
`;
