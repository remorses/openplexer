// Notion API wrapper for openplexer.
// Creates board databases, creates/updates session pages.

import { Client } from '@notionhq/client'

export const STATUS_OPTIONS = [
  { name: 'Not Started', color: 'default' as const },
  { name: 'In Progress', color: 'blue' as const },
  { name: 'Done', color: 'green' as const },
  { name: 'Needs Attention', color: 'red' as const },
  { name: 'Ignored', color: 'gray' as const },
]

export type CreateDatabaseResult = {
  databaseId: string
}

export function createNotionClient({ token }: { token: string }): Client {
  return new Client({ auth: token })
}

export async function createBoardDatabase({
  notion,
  pageId,
}: {
  notion: Client
  pageId: string
}): Promise<CreateDatabaseResult> {
  const database = await notion.databases.create({
    parent: { type: 'page_id', page_id: pageId },
    title: [{ text: { content: 'openplexer - Coding Sessions' } }],
    initial_data_source: {
      properties: {
        Name: { type: 'title', title: {} },
        Status: {
          type: 'select',
          select: { options: STATUS_OPTIONS },
        },
        Repo: { type: 'select', select: { options: [] } },
        Branch: { type: 'url', url: {} },
        'Share URL': { type: 'url', url: {} },
        Resume: { type: 'rich_text', rich_text: {} },
        'Session ID': { type: 'rich_text', rich_text: {} },
        Assignee: { type: 'people', people: {} },
        Folder: { type: 'rich_text', rich_text: {} },
        Discord: { type: 'url', url: {} },
        Updated: { type: 'date', date: {} },
      },
    },
  })

  // Database is created with a default Table view. Create a Board view
  // grouped by Status so sessions show as a kanban board.
  const dataSourceId = 'data_sources' in database
    ? database.data_sources?.[0]?.id
    : undefined
  if (dataSourceId) {
    await notion.views.create({
      database_id: database.id,
      data_source_id: dataSourceId,
      name: 'Board',
      type: 'board',
    })
  }

  return { databaseId: database.id }
}

export async function createSessionPage({
  notion,
  databaseId,
  title,
  sessionId,
  status,
  repoSlug,
  branchUrl,
  shareUrl,
  resumeCommand,
  assigneeId,
  folder,
  discordUrl,
  updatedAt,
}: {
  notion: Client
  databaseId: string
  title: string
  sessionId: string
  status: string
  repoSlug: string
  branchUrl?: string
  shareUrl?: string
  resumeCommand: string
  assigneeId?: string
  folder: string
  discordUrl?: string
  updatedAt?: string
}): Promise<string> {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: title } }] },
    Status: { select: { name: status } },
    'Session ID': { rich_text: [{ text: { content: sessionId } }] },
    Repo: { select: { name: repoSlug } },
    Resume: { rich_text: [{ text: { content: resumeCommand } }] },
    Folder: { rich_text: [{ text: { content: folder } }] },
  }

  if (branchUrl) {
    properties['Branch'] = { url: branchUrl }
  }
  if (shareUrl) {
    properties['Share URL'] = { url: shareUrl }
  }
  if (assigneeId) {
    properties['Assignee'] = { people: [{ id: assigneeId }] }
  }
  if (discordUrl) {
    properties['Discord'] = { url: discordUrl }
  }
  if (updatedAt) {
    properties['Updated'] = { date: { start: updatedAt } }
  }

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties: properties as Parameters<Client['pages']['create']>[0]['properties'],
  })

  return page.id
}

export async function updateSessionPage({
  notion,
  pageId,
  title,
  updatedAt,
}: {
  notion: Client
  pageId: string
  title?: string
  updatedAt?: string
}): Promise<void> {
  const properties: Record<string, unknown> = {}

  if (title) {
    properties['Name'] = { title: [{ text: { content: title } }] }
  }
  if (updatedAt) {
    properties['Updated'] = { date: { start: updatedAt } }
  }

  if (Object.keys(properties).length === 0) {
    return
  }

  await notion.pages.update({
    page_id: pageId,
    properties: properties as Parameters<Client['pages']['update']>[0]['properties'],
  })
}

// Rate-limited queue for Notion API calls (max 3/sec)
const RATE_LIMIT_MS = 350
let lastCallTime = 0

export async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const elapsed = now - lastCallTime
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((resolve) => {
      setTimeout(resolve, RATE_LIMIT_MS - elapsed)
    })
  }
  lastCallTime = Date.now()
  return fn()
}
