// Notion API wrapper for openplexer.
// Creates board databases, creates/updates session pages.

import { Client } from '@notionhq/client'

export const STATUS_OPTIONS = [
  { name: 'Not Started', color: 'default' as const },
  { name: 'In Progress', color: 'blue' as const },
  { name: 'Done', color: 'green' as const },
]

export type CreateDatabaseResult = {
  databaseId: string
}

export function createNotionClient({ token }: { token: string }): Client {
  return new Client({ auth: token })
}

export type RootPage = {
  id: string
  title: string
  url: string
  icon: string
}

// Get root-level pages (parent.type === 'workspace') using notion.search.
// Only pages are returned (not databases). With OAuth integrations,
// only pages the user explicitly shared during consent are searchable,
// so users must share root-level pages for them to appear here.
export async function getRootPages({ notion }: { notion: Client }): Promise<RootPage[]> {
  const pages: RootPage[] = []
  let startCursor: string | undefined

  for (let page = 0; page < 3; page++) {
    const res = await notion.search({
      filter: { property: 'object', value: 'page' },
      page_size: 100,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      ...(startCursor ? { start_cursor: startCursor } : {}),
    })

    for (const result of res.results) {
      if (!('parent' in result) || !('properties' in result)) {
        continue
      }
      // Only show root pages (direct children of workspace), skip databases
      if (result.object !== 'page' || result.parent.type !== 'workspace') {
        continue
      }

      const titleProp = Object.values(result.properties).find((p) => p.type === 'title')
      const title = (() => {
        if (!titleProp || titleProp.type !== 'title') {
          return ''
        }
        return titleProp.title.map((t: { plain_text: string }) => t.plain_text).join('')
      })()

      const icon = (() => {
        if (!result.icon) {
          return ''
        }
        if (result.icon.type === 'emoji') {
          return result.icon.emoji
        }
        return ''
      })()

      pages.push({ id: result.id, title: title || result.url, url: result.url, icon })
    }

    if (!res.has_more || !res.next_cursor) {
      break
    }
    startCursor = res.next_cursor
  }

  return pages
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
    is_inline: true,
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
  // grouped by Status so sessions show as a kanban board, then delete the
  // default Table view so Board becomes the default.
  const dataSourceId = 'data_sources' in database
    ? database.data_sources?.[0]?.id
    : undefined
  if (dataSourceId) {
    // Retrieve the data source to get the Status property ID for group_by
    const dataSource = await notion.dataSources.retrieve({ data_source_id: dataSourceId })
    const statusPropertyId = 'properties' in dataSource
      ? Object.entries(dataSource.properties as Record<string, { id: string; type: string }>)
          .find(([name]) => name === 'Status')?.[1]?.id
      : undefined

    // List existing views (should contain the auto-created Table view)
    const existingViews = await notion.views.list({ database_id: database.id })
    const tableViewIds = existingViews.results.map((v) => v.id)

    // Create the Board view, grouped by Status
    await notion.views.create({
      database_id: database.id,
      data_source_id: dataSourceId,
      name: 'Board',
      type: 'board',
      ...(statusPropertyId && {
        configuration: {
          type: 'board' as const,
          group_by: {
            type: 'select' as const,
            property_id: statusPropertyId,
            sort: { type: 'manual' as const },
            hide_empty_groups: false,
          },
        },
      }),
    })

    // Delete the default Table view(s) so Board is the only (and default) view
    for (const viewId of tableViewIds) {
      await notion.views.delete({ view_id: viewId }).catch(() => {
        // Ignore errors — can't delete the last view, but we just created Board
      })
    }
  }

  return { databaseId: database.id }
}

// Create an example page in the database explaining how sessions appear.
export async function createExamplePage({
  notion,
  databaseId,
}: {
  notion: Client
  databaseId: string
}): Promise<string> {
  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      Name: { title: [{ text: { content: 'Sessions will appear here automatically' } }] },
      Status: { select: { name: 'In Progress' } },
      'Session ID': { rich_text: [{ text: { content: 'example' } }] },
      Repo: { select: { name: 'owner/repo' } },
      Resume: { rich_text: [{ text: { content: 'opencode --session <id>' } }] },
      Folder: { rich_text: [{ text: { content: '/path/to/project' } }] },
    } as Parameters<Client['pages']['create']>[0]['properties'],
    children: [
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: { content: 'Each card on this board represents a coding session from OpenCode, Claude Code, or Codex. openplexer syncs them automatically every few seconds.' },
            },
          ],
        },
      },
      { type: 'divider', divider: {} },
      {
        type: 'heading_3',
        heading_3: {
          rich_text: [{ type: 'text', text: { content: 'What each field means' } }],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: 'Status' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — In Progress while the session is active, Done when finished. You can set Needs Attention or Ignored manually.' } },
          ],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: 'Repo' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — The GitHub repository the session is working in (owner/repo).' } },
          ],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: 'Branch' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — Link to the git branch on GitHub.' } },
          ],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: 'Resume' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — Command to resume the session in your terminal.' } },
          ],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: 'Share URL' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — Public share link for the session (if available).' } },
          ],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: 'Discord' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — Link to the Discord thread (if using kimaki).' } },
          ],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: 'Assignee' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — The Notion user who authorized the integration.' } },
          ],
        },
      },
      { type: 'divider', divider: {} },
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: { content: 'You can archive this card once real sessions start appearing.' },
              annotations: { italic: true, color: 'gray' },
            },
          ],
        },
      },
    ] as Parameters<Client['blocks']['children']['append']>[0]['children'],
  })

  return page.id
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
