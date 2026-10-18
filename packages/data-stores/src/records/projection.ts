import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { quoteIdentifier } from "../server";

const written = z.object({ inserted: z.number(), updated: z.number() });

/**
 * Run the shared load statement with app privileges inside the provenance transaction.
 * A SECURITY DEFINER frame also prevents a customer trigger from RESET ROLE back to the
 * platform connection's identity. The wrapper is private to this uncommitted transaction;
 * the app gets no lasting CREATE privilege or access to the provenance schema.
 */
export async function recordProjection(sql: PostgresChangeStatements, appRole: string) {
  const name = `catalyst.${quoteIdentifier(`projection_${randomUUID().replaceAll("-", "")}`)}`;
  const app = quoteIdentifier(appRole);
  // PostgreSQL 16+ gives a non-superuser creator ADMIN but not SET on its roles.
  // Borrow SET only in this transaction and preserve grants from every other grantor.
  const roleAccess = z.object({ can_set: z.boolean(), own_grant: z.boolean() }).parse(
    (
      await sql.run(
        `
    select pg_has_role(current_user,$1::name,'SET') as can_set,
      exists(select 1 from pg_auth_members m
        where m.roleid=(select oid from pg_roles where rolname=$1::text)
          and m.member=(select oid from pg_roles where rolname=current_user)
          and m.grantor=(select oid from pg_roles where rolname=current_user)) as own_grant`,
        [appRole]
      )
    )[0]
  );
  if (!roleAccess.can_set)
    await sql.script(
      `grant ${app} to current_user with set true${roleAccess.own_grant ? "" : ", inherit false, admin false"} granted by current_user`
    );

  await sql.script(`
    grant create on schema catalyst to ${app};
    create function ${name}(command_text text, row_data jsonb) returns table(inserted integer, updated integer)
      language plpgsql security definer set search_path = pg_catalog as $projection$
      begin
        if command_text is null then set constraints all immediate; return query select 0,0;
        else return query execute command_text using row_data; end if;
      end $projection$;
    revoke all on function ${name}(text,jsonb) from public;
    alter function ${name}(text,jsonb) owner to ${app};
    revoke create on schema catalyst from ${app};
  `);
  return {
    async write(statement: string | null, rows: string) {
      // Its owner may change flags from a trigger, but cannot replace its body without
      // CREATE on catalyst. Restore the frame before every call; drop it before commit.
      await sql.script(
        `set local role ${app}; alter function ${name}(text,jsonb) security definer; alter function ${name}(text,jsonb) set search_path = pg_catalog`
      );
      const result = written.parse(
        (await sql.run(`select * from ${name}($1::text,$2::jsonb)`, [statement, rows]))[0]
      );
      await sql.script("reset role");
      return result;
    },
    async close() {
      await sql.script(`set local role ${app}; drop function ${name}(text,jsonb); reset role`);
      if (!roleAccess.can_set)
        await sql.script(
          roleAccess.own_grant
            ? `grant ${app} to current_user with set false granted by current_user`
            : `revoke ${app} from current_user granted by current_user`
        );
    }
  };
}
