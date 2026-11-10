import { getTableColumns, sql } from "drizzle-orm";
import type { ConversationPersonRow } from "./rows";
import { conversations } from "./schema";

// The people a chat's creator named (CHAT-SHARE-1). Every read of a conversation carries them,
// a run thread those of its root: who reads a chat is decided on the row that is read. The
// statements name their tables in full: drizzle leaves a column of a one-table statement
// unqualified, which a subquery over other tables would read as its own.

/** The named people of the conversation of the enclosing statement, or of its root. */
const conversationPeopleColumn = sql<ConversationPersonRow[]>`coalesce((
  select json_agg(
    json_build_object(
      'userId', cp.user_id,
      'displayLabel', u.display_label,
      'addedAt', cp.added_at
    ) order by cp.added_at, cp.user_id
  )
  from conversation_people cp
  inner join product_users u
    on u.client_instance_id = cp.client_instance_id and u.id = cp.user_id
  where cp.client_instance_id = "conversations"."client_instance_id"
    and cp.conversation_id =
      coalesce("conversations"."parent_conversation_id", "conversations"."id")
), '[]'::json)`;

/** Every column of a conversation with its named people: what `mapConversation` maps. */
export const conversationFields = {
  ...getTableColumns(conversations),
  people: conversationPeopleColumn
};
