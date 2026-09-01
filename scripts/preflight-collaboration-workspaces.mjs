import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required for the Collaboration Workspaces preflight.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  const [summary] = await sql`
    with active_conversations as (
      select id, client_instance_id, owner_user_id
      from conversations
      where status = 'active'
    ),
    conversation_mappings as (
      select conversation.id, conversation.status, product_user.id as mapped_user_id
      from conversations conversation
      left join product_users product_user
        on product_user.client_instance_id = conversation.client_instance_id
        and product_user.id = conversation.owner_user_id
    ),
    per_user as (
      select product_user.client_instance_id, product_user.id,
        count(conversation.id)::bigint as conversation_count
      from product_users product_user
      left join active_conversations conversation
        on conversation.client_instance_id = product_user.client_instance_id
        and conversation.owner_user_id = product_user.id
      group by product_user.client_instance_id, product_user.id
    )
    select
      (select count(*)::bigint from product_users) as user_count,
      (select count(*)::bigint from active_conversations) as conversation_count,
      (select count(*)::bigint from conversation_mappings where mapped_user_id is null)
        as unmapped_conversation_count,
      (select count(*)::bigint from conversation_mappings
        where mapped_user_id is null and status = 'active')
        as unmapped_active_conversation_count,
      (select count(*)::bigint from conversation_mappings
        where mapped_user_id is null and status <> 'active')
        as unmapped_non_active_conversation_count,
      count(*) filter (where conversation_count > 0)::bigint as users_with_conversations,
      coalesce(min(conversation_count), 0)::bigint as minimum_conversations_per_user,
      coalesce(max(conversation_count), 0)::bigint as maximum_conversations_per_user,
      coalesce(avg(conversation_count), 0)::numeric(20, 2) as average_conversations_per_user
    from per_user
  `;

  const userCount = Number(summary.user_count);
  const conversationCount = Number(summary.conversation_count);
  const unmappedConversationCount = Number(summary.unmapped_conversation_count);
  const unmappedActiveConversationCount = Number(summary.unmapped_active_conversation_count);
  const unmappedNonActiveConversationCount = Number(summary.unmapped_non_active_conversation_count);

  console.log("Collaboration Workspaces migration preflight");
  console.log(`Product users: ${userCount}`);
  console.log(`Active conversations: ${conversationCount}`);
  console.log(`Unmapped conversations: ${unmappedConversationCount}`);
  console.log(`Unmapped active conversations: ${unmappedActiveConversationCount}`);
  console.log(`Unmapped non-active conversations: ${unmappedNonActiveConversationCount}`);
  console.log(
    `Per-user active conversations: ${summary.users_with_conversations} users with conversations, ` +
      `min ${summary.minimum_conversations_per_user}, max ${summary.maximum_conversations_per_user}, ` +
      `average ${summary.average_conversations_per_user}`
  );

  if (unmappedConversationCount > 0) {
    console.error(
      `Preflight failed: ${unmappedConversationCount} conversation(s) have no matching product user. Do not deploy migration 0020.`
    );
    process.exitCode = 1;
  } else {
    console.log("Preflight passed: every conversation owner maps to a product user.");
  }
} catch (error) {
  console.error(
    `Collaboration Workspaces preflight failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
