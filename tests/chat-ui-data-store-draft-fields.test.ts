import { describe, expect, it } from "vitest";
import { draftTablesOf } from "@work-shape/catalyst-chat-ui/build-area";

const migration = (number: number, sql: string) => ({ number, name: `m${number}`, sql });

describe("the fields of a Data Store never published, read from its migrations", () => {
  it("names each field with its type in words, whether it must be filled, the key and allowed values", () => {
    const tables = draftTablesOf([
      migration(
        1,
        `-- results per client and month
        CREATE TABLE results (
          client_no text NOT NULL,
          month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
          status text NOT NULL CHECK (status IN ('checked','not_checkable','failed')),
          reason text,
          amount numeric(12, 2),
          checked_at timestamptz NOT NULL,
          tags text[],
          PRIMARY KEY (client_no, month)
        );
        comment on column results.reason is 'Why a check failed';`
      )
    ]);
    expect(tables).toHaveLength(1);
    const [table] = tables;
    expect(table?.name).toBe("results");
    expect(table?.fields.map((field) => [field.name, field.type])).toEqual([
      ["client_no", "text"],
      ["month", "text"],
      ["status", "text"],
      ["reason", "text"],
      ["amount", "number"],
      ["checked_at", "timestamp"],
      ["tags", "text[]"]
    ]);
    const field = (name: string) => table?.fields.find((each) => each.name === name);
    expect(field("client_no")).toMatchObject({ primaryKey: true, nullable: false });
    expect(field("month")).toMatchObject({ primaryKey: true, nullable: false });
    expect(field("status")?.allowed).toEqual(["checked", "not_checkable", "failed"]);
    expect(field("month")?.allowed).toBeUndefined();
    expect(field("reason")).toMatchObject({ nullable: true, comment: "Why a check failed" });
    expect(field("amount")?.nativeType).toBe("numeric(12, 2)");
  });

  it("follows later migrations that add, rename and drop fields and tables", () => {
    const tables = draftTablesOf([
      migration(1, 'create table if not exists public."Leads" (id bigint primary key, name text);'),
      migration(2, 'alter table "Leads" add column email varchar(200) not null, drop column name;'),
      migration(
        3,
        'alter table "Leads" rename column email to mail; create table tmp (x int); drop table tmp;'
      )
    ]);
    expect(tables.map((table) => table.name)).toEqual(["Leads"]);
    expect(tables[0]?.fields).toEqual([
      { name: "id", type: "integer", nativeType: "bigint", nullable: false, primaryKey: true },
      { name: "mail", type: "text", nativeType: "varchar(200)", nullable: false, primaryKey: false }
    ]);
  });

  it("says nothing where it reads no table", () => {
    expect(draftTablesOf([migration(1, "create index on leads (name);")])).toEqual([]);
    expect(draftTablesOf([migration(1, "")])).toEqual([]);
  });
});
