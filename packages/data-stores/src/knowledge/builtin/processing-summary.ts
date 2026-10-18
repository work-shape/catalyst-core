import { z } from "zod";
import type { KnowledgeDocumentStore } from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

const group = z.object({
  processingKey: z.string(),
  processorRevision: z.string(),
  count: z.number(),
  tokens: z.number(),
  fingerprint: z.string(),
  unestimated: z.number()
});

// Choose the same canonical live copy as processingContents, then classify and aggregate in
// the owned database. Neither filenames nor per-content hashes leave it for a review.
export async function processingSummary(
  sql: PostgresChangeStatements,
  input: Parameters<KnowledgeDocumentStore["processingSummary"]>[0]
) {
  return z.array(group).parse(
    await sql.run(
      `
    with documents as materialized (
      select distinct on (content_sha256) content_sha256, file_name, source_item_id
      from catalyst_kb.documents where withdrawn_at is null
      order by content_sha256, added_at, id
    ), metadata as (
      select c.*, d.file_name as name, coalesce(i.path,d.file_name) as path,
        coalesce(i.mime,case c.format when 'pdf' then 'application/pdf'
          when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          when 'markdown' then 'text/markdown' else 'text/plain' end) as mime,
        i.size
      from catalyst_kb.contents c join documents d on d.content_sha256=c.sha256
      left join catalyst_kb.source_items i on i.id=d.source_item_id
    ), classified as (
      select m.*, p.rule->'keys'->>m.format as previous_key,
        n.rule->'keys'->>m.format as next_key, n.rule->>'processorRevision' as next_revision
      from metadata m
      cross join lateral (${classification("$1")}) p
      cross join lateral (${classification("$2")}) n
    ), tokens as (
      select content_sha256, sum(token_count) as n from catalyst_kb.chunks group by content_sha256
    )
    select next_key as "processingKey", next_revision as "processorRevision",
      count(*)::float8 as count,
      sum(coalesce(nullif(t.n,0),ceil(c.size/3.0),0))::float8 as tokens,
      md5(string_agg(c.sha256,'' order by c.sha256)) as fingerprint,
      count(*) filter (where coalesce(t.n,0)=0 and c.size is null)::float8 as unestimated
    from classified c left join tokens t on t.content_sha256=c.sha256
    where coalesce(c.processing_key,c.previous_key) is distinct from c.next_key
      or coalesce(c.processor_revision,'text@1') is distinct from c.next_revision
    group by next_key,next_revision
    order by next_key,next_revision`,
      [JSON.stringify(input.previous), JSON.stringify(input.next)]
    )
  );
}

function classification(parameter: string) {
  return `select rule from jsonb_array_elements(${parameter}::jsonb) with ordinality r(rule,ordinal)
    where not exists (
      select 1 from jsonb_each(rule->'match') f(field,patterns)
      where not exists (
        select 1 from jsonb_array_elements_text(patterns) pattern
        where (case field when 'name' then m.name when 'path' then m.path else m.mime end) collate "C" ~ pattern
          or (field='path' and regexp_replace(m.path,'^/','') collate "C" ~ pattern)
      )
    ) order by ordinal limit 1`;
}
