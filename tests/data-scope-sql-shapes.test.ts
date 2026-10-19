import { describe, expect, it } from "vitest";
import {
  NoopAuditRecorder,
  asClientInstanceId,
  createPlatformId,
  isAppError,
  type ActorAccess,
  type AuthenticatedUser,
  type JsonObject,
  type ScopeAssignmentInput
} from "@work-shape/catalyst-core";
import { useDataStoreWorld, manifest, refusal } from "./support/data-store-world";
import { accessOf } from "./support/access";
import { required } from "./support/assertions";

/**
 * SCOPE-1: every SQL read of a scoped table is rewritten so the table's name means the caller's
 * rows. The rewrite finds the names with a tokenizer, so each shape here is one Postgres reads
 * differently from a naive scan: a viewer assigned 101 and 102 gets only those rows, `all` gets
 * 103 as well, and a viewer without an assignment gets none.
 */
const dimension = { mandant: { label: "Mandant", valueType: "text" as const } };
const scoped = manifest("tables: { findings: { scope: { mandant: mandant_nr } } }\n");
const init = {
  path: "migrations/0001_init.sql",
  text: `create table findings (id int primary key, mandant_nr text not null, note text not null, amount int not null);
insert into findings values (1, '101', 'note-101', 10), (2, '102', 'note-102', 20), (3, '103', 'secret-103', 30);
create table clients (mandant_nr text primary key, name text not null);
insert into clients values ('101', 'Alpha'), ('102', 'Beta'), ('103', 'Gamma');`
};
const person: AuthenticatedUser = {
  id: "shape-person",
  externalUserId: "shape-person",
  displayLabel: "Shape person",
  clientInstanceId: asClientInstanceId("scope-shapes"),
  roles: ["user"],
  permissionRefs: [],
  authSource: "test"
};
const access = (values: ScopeAssignmentInput["values"]) =>
  accessOf(person, {
    scopeAssignments: [
      { dimension: "mandant", holderKind: "user", holderId: person.id, effect: "allow", values }
    ]
  });
const viewers = { assigned: access(["101", "102"]), all: access("all"), none: access([]) };
type Viewer = keyof typeof viewers;

/** What one viewer reads: the column `m` of each row, sorted, or the refusal's reason. */
type Read = (string | null)[] | "error";
interface Shape {
  name: string;
  sql: string;
  parameters?: unknown[];
  expected: Record<Viewer, Read>;
}
const rows = (assigned: Read, all: Read, none: Read = []): Record<Viewer, Read> => ({
  assigned,
  all,
  none
});
const SCOPED = rows(["101", "102"], ["101", "102", "103"]);

const shapes: Shape[] = [
  // Plain reads, filters and parameters.
  { name: "plain select", sql: "select mandant_nr as m from findings", expected: SCOPED },
  {
    name: "select * and folded case",
    sql: "SELECT F.MANDANT_NR AS m FROM (SELECT * FROM Findings) F",
    expected: SCOPED
  },
  { name: "where", sql: "select mandant_nr as m from findings where amount > 0", expected: SCOPED },
  {
    name: "where naming another scope",
    sql: "select mandant_nr as m from findings where mandant_nr = '103'",
    expected: rows([], ["103"])
  },
  {
    name: "parameter naming another scope",
    sql: "select mandant_nr as m from findings where mandant_nr = any($1::text[])",
    parameters: [["101", "103"]],
    expected: rows(["101"], ["101", "103"])
  },
  {
    name: "or true",
    sql: "select mandant_nr as m from findings where mandant_nr = '103' or true",
    expected: SCOPED
  },
  {
    name: "id lookup of another scope's row",
    sql: "select mandant_nr as m from findings where id = 3",
    expected: rows([], ["103"])
  },
  {
    name: "qualified by the table's own name",
    sql: "select findings.mandant_nr as m from findings",
    expected: SCOPED
  },
  { name: "only", sql: "select mandant_nr as m from only findings", expected: SCOPED },
  {
    name: "whole-row reference",
    sql: "select (f).mandant_nr as m from findings f",
    expected: SCOPED
  },
  // Joins with an unscoped table.
  {
    name: "inner join with an unscoped table",
    sql: "select f.mandant_nr as m from findings f join clients c on c.mandant_nr = f.mandant_nr",
    expected: SCOPED
  },
  {
    name: "unscoped table left-joined to the scoped one",
    sql: "select c.mandant_nr || ':' || coalesce(f.note, '-') as m from clients c left join findings f using (mandant_nr)",
    expected: rows(
      ["101:note-101", "102:note-102", "103:-"],
      ["101:note-101", "102:note-102", "103:secret-103"],
      ["101:-", "102:-", "103:-"]
    )
  },
  {
    name: "comma join with a where",
    sql: "select f.mandant_nr as m from clients c, findings f where c.mandant_nr = f.mandant_nr",
    expected: SCOPED
  },
  {
    name: "lateral",
    sql: "select x.m from clients c, lateral (select f.mandant_nr as m from findings f where f.mandant_nr = c.mandant_nr) x",
    expected: SCOPED
  },
  // Subqueries.
  {
    name: "exists",
    sql: "select c.mandant_nr as m from clients c where exists (select 1 from findings f where f.mandant_nr = c.mandant_nr)",
    expected: SCOPED
  },
  {
    name: "in subquery",
    sql: "select mandant_nr as m from clients where mandant_nr in (select mandant_nr from findings)",
    expected: SCOPED
  },
  {
    name: "not in subquery",
    sql: "select mandant_nr as m from clients where mandant_nr not in (select mandant_nr from findings)",
    expected: rows(["103"], [], ["101", "102", "103"])
  },
  {
    name: "scalar subquery",
    sql: "select (select string_agg(mandant_nr, ',' order by mandant_nr) from findings) as m",
    expected: rows(["101,102"], ["101,102,103"], [null])
  },
  {
    name: "subquery in from aliased as the table",
    sql: "select findings.m from (select mandant_nr as m from findings) findings",
    expected: SCOPED
  },
  // CTEs.
  {
    name: "cte",
    sql: "with x as (select * from findings) select mandant_nr as m from x",
    expected: SCOPED
  },
  {
    name: "materialized cte selecting another scope",
    sql: "with x as materialized (select mandant_nr from findings where note like 'secret%') select mandant_nr as m from x",
    expected: rows([], ["103"])
  },
  {
    name: "recursive cte",
    sql: "with recursive r(n) as (select 1 union all select n + 1 from r where n < 2) select f.mandant_nr as m from findings f, r where r.n = 1",
    expected: SCOPED
  },
  {
    name: "cte with a comment before recursive",
    sql: "WITH /* report */ RECURSIVE r(n) as (select 1) select mandant_nr as m from findings, r",
    expected: SCOPED
  },
  {
    name: "nested with in a subquery",
    sql: "select x.m from (with y as (select mandant_nr as m from findings) select m from y) x",
    expected: SCOPED
  },
  // Aggregates, grouping, ordering and paging.
  {
    name: "count",
    sql: "select count(*)::text as m from findings",
    expected: rows(["2"], ["3"], ["0"])
  },
  {
    name: "sum",
    sql: "select sum(amount)::text as m from findings",
    expected: rows(["30"], ["60"], [null])
  },
  {
    name: "group by having",
    sql: "select mandant_nr as m from findings group by mandant_nr having count(*) > 0",
    expected: SCOPED
  },
  {
    name: "window over every row",
    sql: "select mandant_nr || '/' || sum(amount) over () as m from findings",
    expected: rows(["101/30", "102/30"], ["101/60", "102/60", "103/60"])
  },
  {
    name: "order by desc limit 1",
    sql: "select mandant_nr as m from findings order by mandant_nr desc limit 1",
    expected: rows(["102"], ["103"])
  },
  {
    name: "offset",
    sql: "select mandant_nr as m from findings order by mandant_nr offset 1",
    expected: rows(["102"], ["102", "103"])
  },
  {
    name: "distinct on",
    sql: "select distinct on (mandant_nr) mandant_nr as m from findings order by mandant_nr, id",
    expected: SCOPED
  },
  {
    name: "union with an unscoped table",
    sql: "select mandant_nr as m from findings union select mandant_nr from clients where false",
    expected: SCOPED
  },
  {
    name: "except",
    sql: "select mandant_nr as m from clients except select mandant_nr from findings",
    expected: rows(["103"], [], ["101", "102", "103"])
  },
  {
    name: "json of whole rows",
    sql: "select json_agg(f order by id)::text as m from findings f",
    // Checked by row count and the secret's absence below.
    expected: rows([], [], [null])
  },
  // Comments.
  {
    name: "line comment hiding a filter",
    sql: "select mandant_nr as m from findings -- where mandant_nr = '101'",
    expected: SCOPED
  },
  {
    name: "line comment holding keywords",
    sql: "select mandant_nr as m -- from clients\nfrom findings",
    expected: SCOPED
  },
  {
    name: "line comment ended by CRLF",
    sql: "select mandant_nr as m -- note\r\nfrom findings",
    expected: SCOPED
  },
  {
    // Postgres ends a line comment at a carriage return as well as at a newline.
    name: "line comment ended by a lone carriage return",
    sql: "select mandant_nr as m -- note\rfrom findings",
    expected: SCOPED
  },
  {
    // The executor's screen reads the comment to the end and refuses: closed, not open.
    name: "leading line comment ended by a lone carriage return",
    sql: "-- report\rselect mandant_nr as m from findings",
    expected: rows("error", "error", "error")
  },
  {
    name: "block comment holding keywords",
    sql: "select /* from clients */ mandant_nr as m from findings",
    expected: SCOPED
  },
  {
    name: "nested block comment",
    sql: "select /* a /* from clients */ still a comment */ mandant_nr as m from findings",
    expected: SCOPED
  },
  {
    name: "block comment glued to the table name",
    sql: "select mandant_nr as m from/**/findings/**/",
    expected: SCOPED
  },
  {
    name: "leading block comment",
    sql: "/* report */ select mandant_nr as m from findings",
    expected: SCOPED
  },
  // Quoted identifiers.
  {
    name: "quoted identifiers",
    sql: 'select f."mandant_nr" as "m" from "findings" as "f"',
    expected: SCOPED
  },
  {
    name: "quoted identifier with an escaped quote as alias",
    sql: 'select mandant_nr as "m" from findings as "a""b"',
    expected: SCOPED
  },
  // String literals and dollar quotes.
  {
    name: "string literal holding keywords",
    sql: "select mandant_nr as m from findings where note <> 'from clients; -- /*'",
    expected: SCOPED
  },
  {
    name: "string with a doubled quote",
    sql: "select mandant_nr as m from findings where note <> 'it''s /* not a comment'",
    expected: SCOPED
  },
  {
    name: "escape string with a backslash quote",
    sql: "select mandant_nr as m from findings where note <> E'x\\' from clients --'",
    expected: SCOPED
  },
  {
    name: "escape string after a comment",
    sql: "select mandant_nr as m from findings where note <> /**/e'\\''",
    expected: SCOPED
  },
  {
    name: "standard string ending in a backslash",
    sql: "select mandant_nr as m from findings where note <> 'x\\' and note <> '-- y'",
    expected: SCOPED
  },
  {
    name: "dollar-quoted string holding keywords",
    sql: "select mandant_nr as m from findings where note <> $$ from clients ' -- $$",
    expected: SCOPED
  },
  {
    name: "tagged dollar quote holding a plain one",
    sql: "select mandant_nr as m from findings where note <> $q$ $$ ' /* $q$",
    expected: SCOPED
  },
  {
    name: "dollar quote holding the table's name",
    sql: "select $x$select * from findings$x$ as q, mandant_nr as m from findings",
    expected: SCOPED
  },
  {
    // Postgres takes any non-ASCII character into a dollar quote's tag.
    name: "dollar quote with a non-ASCII tag hiding a quote",
    sql: "select x.m from (select $€$'$€$ as q) d, (select mandant_nr as m from findings) x --'",
    expected: SCOPED
  },
  {
    name: "dollar quote with a non-ASCII tag after a letter",
    sql: "select x.m from (select $a·$'$a·$ as q) d, (select mandant_nr as m from findings) x --'",
    expected: SCOPED
  },
  // Statement shapes around the rewrite.
  {
    name: "two statements",
    sql: "select 1 as m; select mandant_nr as m from findings",
    expected: rows("error", "error", "error")
  },
  {
    name: "a predicate that fails on another scope's row",
    sql: "select case when mandant_nr = '103' then (note::int)::text else mandant_nr end as m from findings",
    expected: rows(["101", "102"], "error")
  }
];

describe("SQL shapes on a scoped table (SCOPE-1)", () => {
  const { setup, publish, settle } = useDataStoreWorld("scope_shapes");
  const world = async () => {
    const world = await setup("shapes", {}, undefined, undefined, undefined, dimension);
    await settle(world, await publish(world, [scoped, init]), 1);
    return world;
  };
  type World = Awaited<ReturnType<typeof world>>;
  const query = async (w: World, input: JsonObject, viewer: ActorAccess) => {
    const operation = required(
      await w.dataStores.operationSource.resolve("data_store.findings.query")
    );
    return operation.execute(operation.inputSchema.parse(input), {
      runId: createPlatformId("opr"),
      actor: person,
      access: viewer,
      origin: { kind: "user" },
      runtime: {},
      correlationId: "scope-shapes",
      audit: new NoopAuditRecorder()
    });
  };
  const read = async (w: World, shape: Shape, viewer: ActorAccess) => {
    try {
      const result = (await query(
        w,
        {
          sql: shape.sql,
          ...(shape.parameters ? { parameters: shape.parameters } : {})
        } as JsonObject,
        viewer
      )) as { rows: { m: string | null }[] };
      return { m: result.rows.map((row) => row.m).sort() as Read, text: JSON.stringify(result) };
    } catch (error) {
      return {
        m: "error" as const,
        text: isAppError(error) ? JSON.stringify(error) : String(error)
      };
    }
  };

  it("returns only the viewer's rows for every shape; all reads 103, nobody unassigned reads any", async () => {
    const w = await world();
    for (const shape of shapes) {
      for (const viewer of Object.keys(viewers) as Viewer[]) {
        const { m, text } = await read(w, shape, viewers[viewer]);
        const label = `${shape.name} (${viewer}): ${JSON.stringify(shape.sql)}`;
        if (viewer !== "all") expect.soft(text, label).not.toContain("secret-103");
        if (shape.name === "json of whole rows" && viewer === "assigned") {
          expect.soft(m === "error" ? m : m.length, label).toBe(1);
          continue;
        }
        if (shape.name === "json of whole rows" && viewer === "all") {
          expect.soft(text, label).toContain("secret-103");
          continue;
        }
        expect.soft(m, label).toEqual(shape.expected[viewer]);
      }
    }
  });

  it.each([
    ["a schema-qualified name", "select * from public.findings"],
    ["a quoted schema-qualified name", 'select * from "public"."findings"'],
    ["a schema-qualified name split by a comment", "select * from public./**/findings"],
    ["a Unicode-escaped identifier", 'select * from U&"findings"'],
    ["a lower-case Unicode-escaped identifier", 'select * from u&"\\0066indings"'],
    ["a relation read by name", "select table_to_xml('findings', true, false, '')"],
    ["SQL run from text", "select query_to_xml('select * from findings', true, false, '')"],
    ["column statistics", 'select * from "pg_stats"'],
    ["text search statistics", "select * from ts_stat('select note::tsvector from findings')"],
    ["a statement that is no select", "table findings"]
  ])("refuses %s for a scoped viewer", async (_shape, sql) => {
    const w = await world();
    expect(await refusal(query(w, { sql }, viewers.assigned))).toMatchObject({
      code: "VALIDATION_FAILED"
    });
  });
});
