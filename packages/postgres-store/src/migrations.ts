import type { Sql } from "postgres";

export async function runPostgresMigrations(sql: Sql): Promise<void> {
  await sql`
    create table if not exists "user" (
      id text primary key,
      name text not null,
      email text not null unique,
      "emailVerified" boolean not null default false,
      image text,
      "createdAt" timestamptz not null default now(),
      "updatedAt" timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists "session" (
      id text primary key,
      "expiresAt" timestamptz not null,
      token text not null unique,
      "createdAt" timestamptz not null default now(),
      "updatedAt" timestamptz not null default now(),
      "ipAddress" text,
      "userAgent" text,
      "userId" text not null references "user"(id) on delete cascade
    )
  `;
  await sql`
    create index if not exists session_user_id_idx
    on "session" ("userId")
  `;
  await sql`
    create table if not exists account (
      id text primary key,
      "accountId" text not null,
      "providerId" text not null,
      "userId" text not null references "user"(id) on delete cascade,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      scope text,
      password text,
      "createdAt" timestamptz not null default now(),
      "updatedAt" timestamptz not null default now()
    )
  `;
  await sql`
    create index if not exists account_user_id_idx
    on account ("userId")
  `;
  await sql`
    create unique index if not exists account_account_provider_idx
    on account ("accountId", "providerId")
  `;
  await sql`
    create table if not exists verification (
      id text primary key,
      identifier text not null,
      value text not null,
      "expiresAt" timestamptz not null,
      "createdAt" timestamptz not null default now(),
      "updatedAt" timestamptz not null default now()
    )
  `;
  await sql`
    create index if not exists verification_identifier_idx
    on verification (identifier)
  `;
  await sql`
    create table if not exists standalone_auth_profiles (
      client_instance_id text not null,
      auth_user_id text not null references "user"(id) on delete cascade,
      external_user_id text not null,
      display_label text not null,
      roles jsonb not null default '[]'::jsonb,
      permission_refs jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (client_instance_id, auth_user_id),
      unique (client_instance_id, external_user_id)
    )
  `;
  await sql`
    create table if not exists product_users (
      id text primary key,
      client_instance_id text not null,
      display_label text not null,
      email text,
      roles jsonb not null default '["user"]'::jsonb,
      permission_refs jsonb not null default '[]'::jsonb,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_authenticated_at timestamptz
    )
  `;
  await sql`
    create index if not exists product_users_client_idx
    on product_users (client_instance_id)
  `;
  await sql`
    create table if not exists user_identities (
      client_instance_id text not null,
      user_id text not null references product_users(id) on delete cascade,
      auth_source text not null,
      external_user_id text not null,
      display_label text,
      email text,
      email_verified boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_authenticated_at timestamptz,
      primary key (client_instance_id, auth_source, external_user_id)
    )
  `;
  await sql`
    create index if not exists user_identities_user_idx
    on user_identities (client_instance_id, user_id)
  `;
  await sql`
    create table if not exists conversations (
      id text primary key,
      client_instance_id text not null,
      owner_user_id text not null,
      owner_external_user_id text not null,
      title text not null,
      status text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      retained_until timestamptz not null,
      deleted_at timestamptz
    )
  `;
  await sql`
    create index if not exists conversations_owner_idx
    on conversations (client_instance_id, owner_external_user_id, updated_at desc)
  `;
  await sql`
    create index if not exists conversations_owner_user_idx
    on conversations (client_instance_id, owner_user_id, updated_at desc)
  `;
  await sql`
    create table if not exists messages (
      id text primary key,
      client_instance_id text not null,
      conversation_id text not null references conversations(id) on delete cascade,
      role text not null,
      text text not null,
      created_at timestamptz not null,
      metadata jsonb not null default '{}'::jsonb
    )
  `;
  await sql`
    create index if not exists messages_conversation_idx
    on messages (client_instance_id, conversation_id, created_at asc)
  `;
  await sql`
    create table if not exists audit_events (
      id text primary key,
      client_instance_id text not null,
      type text not null,
      status text not null,
      actor jsonb,
      subject text,
      reason text,
      correlation_id text not null,
      created_at timestamptz not null,
      metadata jsonb not null default '{}'::jsonb
    )
  `;
  await sql`
    create index if not exists audit_events_client_created_idx
    on audit_events (client_instance_id, created_at desc)
  `;
  await sql`
    create table if not exists model_usage_events (
      id text primary key,
      client_instance_id text not null,
      conversation_id text not null,
      agent_run_id text not null,
      agent_name text not null,
      provider_id text not null,
      model text not null,
      input_tokens integer not null,
      output_tokens integer not null,
      total_tokens integer not null,
      source text not null,
      correlation_id text not null,
      created_at timestamptz not null
    )
  `;
  await sql`
    create index if not exists model_usage_events_client_created_idx
    on model_usage_events (client_instance_id, created_at desc)
  `;
}
