// Drizzle schema for the UserStore Durable Object's SQLite database.
// Single "admin" DO instance holds all users and boards.
// Inspired by better-auth's account/provider pattern — one account
// per Notion OAuth user, with boards as child resources.

import * as sqliteCore from 'drizzle-orm/sqlite-core'
import * as orm from 'drizzle-orm'

const { sqliteTable, text, integer, uniqueIndex } = sqliteCore

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey().notNull(),
    notionUserId: text('notion_user_id').notNull(),
    notionUserName: text('notion_user_name'),
    workspaceId: text('workspace_id').notNull(),
    workspaceName: text('workspace_name'),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('accounts_notion_user_id_unique').on(table.notionUserId),
    uniqueIndex('accounts_refresh_token_unique').on(table.refreshToken),
  ],
)

export const accountsRelations = orm.relations(accounts, ({ many }) => ({
  boards: many(boards),
}))

export const boards = sqliteTable(
  'boards',
  {
    id: text('id').primaryKey().notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    notionDatabaseId: text('notion_database_id').notNull(),
    notionPageId: text('notion_page_id').notNull(),
    trackedRepos: text('tracked_repos').notNull().default('[]'),
    connectedAt: text('connected_at').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('boards_notion_database_id_unique').on(table.notionDatabaseId),
  ],
)

export const boardsRelations = orm.relations(boards, ({ one }) => ({
  account: one(accounts, {
    fields: [boards.accountId],
    references: [accounts.id],
  }),
}))
