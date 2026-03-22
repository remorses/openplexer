// Durable Object that stores all user accounts and boards in a single
// SQLite instance. Accessed via idFromName("admin") — one global instance.
// Uses Drizzle ORM for type-safe queries and automatic migrations.
// Public methods are called as type-safe RPC from the Worker.

import { DurableObject } from 'cloudflare:workers'
import * as durable from 'drizzle-orm/durable-sqlite'
import * as migrator from 'drizzle-orm/durable-sqlite/migrator'
import * as orm from 'drizzle-orm'
import migrations from '../drizzle/migrations.js'
import * as schema from './db/schema.ts'
import type { Env } from './env.ts'

export class UserStore extends DurableObject<Env> {
  db: durable.DrizzleSqliteDODatabase<typeof schema>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.db = durable.drizzle(ctx.storage, { schema })
    ctx.blockConcurrencyWhile(async () => {
      await migrator.migrate(this.db, migrations)
    })
  }

  /** Find an account by its Notion refresh token.
   *  Used for auth — the CLI sends its refresh token as Bearer. */
  async getAccountByRefreshToken(refreshToken: string) {
    const row = this.db.query.accounts.findFirst({
      where: orm.eq(schema.accounts.refreshToken, refreshToken),
    }).sync()
    return row ?? null
  }

  /** Create or update an account after Notion OAuth.
   *  Upserts by notionUserId — if the user re-authorizes, tokens are updated.
   *  Returns the account ID. */
  async upsertAccount(data: {
    notionUserId: string
    notionUserName: string | null
    workspaceId: string
    workspaceName: string | null
    accessToken: string
    refreshToken: string
  }) {
    const now = Date.now()

    const existing = this.db.query.accounts.findFirst({
      where: orm.eq(schema.accounts.notionUserId, data.notionUserId),
    }).sync()

    if (existing) {
      this.db
        .update(schema.accounts)
        .set({
          notionUserName: data.notionUserName,
          workspaceId: data.workspaceId,
          workspaceName: data.workspaceName,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          updatedAt: now,
        })
        .where(orm.eq(schema.accounts.id, existing.id))
        .run()
      return existing.id
    }

    const id = crypto.randomUUID()
    this.db
      .insert(schema.accounts)
      .values({
        id,
        notionUserId: data.notionUserId,
        notionUserName: data.notionUserName,
        workspaceId: data.workspaceId,
        workspaceName: data.workspaceName,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return id
  }

  /** Save a board for an account.
   *  If a board with the same notionDatabaseId exists, update it.
   *  Otherwise insert a new row. Returns the board ID. */
  async saveBoard(
    accountId: string,
    data: {
      notionDatabaseId: string
      notionPageId: string
      trackedRepos: string[]
      connectedAt: string
    },
  ) {
    const existing = this.db.query.boards.findFirst({
      where: orm.eq(schema.boards.notionDatabaseId, data.notionDatabaseId),
    }).sync()

    if (existing) {
      this.db
        .update(schema.boards)
        .set({
          accountId,
          notionPageId: data.notionPageId,
          trackedRepos: JSON.stringify(data.trackedRepos),
          connectedAt: data.connectedAt,
        })
        .where(orm.eq(schema.boards.id, existing.id))
        .run()
      return existing.id
    }

    const id = crypto.randomUUID()
    this.db
      .insert(schema.boards)
      .values({
        id,
        accountId,
        notionDatabaseId: data.notionDatabaseId,
        notionPageId: data.notionPageId,
        trackedRepos: JSON.stringify(data.trackedRepos),
        connectedAt: data.connectedAt,
        createdAt: Date.now(),
      })
      .run()
    return id
  }
}
