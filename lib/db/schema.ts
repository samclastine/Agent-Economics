import {
  sqliteTable, text, integer, index,
} from 'drizzle-orm/sqlite-core';

/** All ids are UUID strings, generated app-side. */
const uuid = (name: string) => text(name).$defaultFn(() => crypto.randomUUID());

const nowMs = () => new Date();

export const users = sqliteTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull().default('owner'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowMs),
});

export const agents = sqliteTable('agents', {
  id: uuid('id').primaryKey(),
  ownerUserId: text('owner_user_id').references(() => users.id),
  name: text('name').notNull(),
  role: text('role').notNull(), // 'dispatcher' | 'worker'
  modelConfig: text('model_config', { mode: 'json' }).notNull().$defaultFn(() => ({})),
  systemPromptVersion: text('system_prompt_version').notNull().default('v1'),
  status: text('status').notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowMs),
});

export const agentWallets = sqliteTable('agent_wallets', {
  id: uuid('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id).unique(),
  chainId: integer('chain_id').notNull(),
  address: text('address').notNull(),
  walletType: text('wallet_type').notNull().default('evm_eoa'),
  keyReference: text('key_reference'), // reference to signer config, never raw key
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
});

export const agentRuns = sqliteTable('agent_runs', {
  id: uuid('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  jobId: text('job_id'),
  threadId: text('thread_id').notNull().unique(),
  status: text('status').notNull().default('RUNNING'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowMs),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  error: text('error'),
});

export const agentEvents = sqliteTable('agent_events', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  runId: text('run_id').references(() => agentRuns.id),
  agentId: text('agent_id').references(() => agents.id),
  jobId: text('job_id'),
  type: text('type').notNull(),
  payloadJson: text('payload_json', { mode: 'json' }).notNull().$defaultFn(() => ({})),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(nowMs),
}, (t) => [index('agent_events_cursor_idx').on(t.id)]);
