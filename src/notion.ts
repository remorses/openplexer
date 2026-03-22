// Notion API wrapper for openplexer.
// Creates board databases, creates/updates session pages.

import { Client } from '@notionhq/client'
import type {
  DatabaseObjectResponse,
  DataSourceObjectResponse,
  PageObjectResponse,
} from '@notionhq/client/build/src/api-endpoints.js'
import type { AcpClient } from './config.ts'

export const STATUS_OPTIONS = [
  { name: 'Not Started', color: 'default' as const },
  { name: 'In Progress', color: 'blue' as const },
  { name: 'Done', color: 'green' as const },
]

export const ACTIVITY_OPTIONS = [
  { name: 'Running', color: 'blue' as const },
  { name: 'Idle', color: 'yellow' as const },
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
      // Only full page objects (not partial) that are root pages (direct children of workspace)
      if (result.object !== 'page') continue
      const page = result as PageObjectResponse
      if (!page.parent || page.parent.type !== 'workspace') continue

      const titleProp = Object.values(page.properties).find((p) => p.type === 'title')
      const title = (() => {
        if (!titleProp || titleProp.type !== 'title') {
          return ''
        }
        return titleProp.title.map((t: { plain_text: string }) => t.plain_text).join('')
      })()

      const icon = (() => {
        if (!page.icon) {
          return ''
        }
        if (page.icon.type === 'emoji') {
          return page.icon.emoji
        }
        return ''
      })()

      pages.push({ id: page.id, title: title || page.url, url: page.url, icon })
    }

    if (!res.has_more || !res.next_cursor) {
      break
    }
    startCursor = res.next_cursor
  }

  return pages
}

/** Build the canonical set of properties for a board database.
 *  Used both at creation and to ensure existing boards have all expected props. */
function buildBoardProperties({ clients, assigneeField }: { clients: AcpClient[]; assigneeField?: boolean }): Record<string, unknown> {
  const hasOpencode = clients.includes('opencode')

  const properties: Record<string, unknown> = {
    Name: { type: 'title', title: {} },
    Status: {
      type: 'select',
      select: { options: STATUS_OPTIONS },
    },
    Repo: { type: 'select', select: { options: [] } },
    Branch: { type: 'rich_text', rich_text: {} },
    'Share URL': { type: 'url', url: {} },
    Resume: { type: 'rich_text', rich_text: {} },
    'Session ID': { type: 'rich_text', rich_text: {} },
    Folder: { type: 'rich_text', rich_text: {} },
    Created: { type: 'date', date: {} },
    Updated: { type: 'date', date: {} },
    Activity: {
      type: 'select',
      select: { options: ACTIVITY_OPTIONS },
    },
    Model: { type: 'rich_text', rich_text: {} },
  }

  // Assignee (people property) is opt-in because Notion sends a notification
  // to the assigned user on every page create and there is no API way to
  // suppress it. Users must manually set the property notifications to "None"
  // in the Notion UI to avoid spam.
  if (assigneeField) {
    properties['Assignee'] = { type: 'people', people: {} }
  }

  if (hasOpencode) {
    properties['Kimaki'] = { type: 'url', url: {} }
  }

  return properties
}

export async function createBoardDatabase({
  notion,
  pageId,
  clients,
  assigneeField,
}: {
  notion: Client
  pageId: string
  clients: AcpClient[]
  assigneeField?: boolean
}): Promise<CreateDatabaseResult> {
  const properties = buildBoardProperties({ clients, assigneeField })

  const database = await notion.databases.create({
    parent: { type: 'page_id', page_id: pageId },
    is_inline: true,
    title: [{ text: { content: 'openplexer - Coding Sessions' } }],
    initial_data_source: {
      properties: properties as Parameters<Client['databases']['create']>[0]['initial_data_source'] extends { properties?: infer P } ? P : never,
    },
  })

  // Database is created with a default Table view. Create a Board view
  // grouped by Status so sessions show as a kanban board, then delete the
  // default Table view so Board becomes the default.
  const db = database as DatabaseObjectResponse
  const dataSourceId = db.data_sources?.[0]?.id
  if (dataSourceId) {
    // Retrieve the data source to get property IDs for group_by and visibility
    const dataSource = await notion.dataSources.retrieve({ data_source_id: dataSourceId }) as DataSourceObjectResponse
    const dsProps = dataSource.properties as Record<string, { id: string; type: string }>

    const propId = (name: string) =>
      Object.entries(dsProps).find(([n]) => n === name)?.[1]?.id

    const statusPropertyId = propId('Status')

    // Properties visible on board cards
    // Status is the board grouping property — Notion hides it from cards by default
    const visibleOnCard = new Set(['Repo', 'Updated', 'Created', 'Activity', 'Model'])
    const propertiesConfig = Object.entries(dsProps).map(([name, { id }]) => ({
      property_id: id,
      visible: visibleOnCard.has(name),
    }))

    // List existing views (should contain the auto-created Table view)
    const existingViews = await notion.views.list({ database_id: database.id })
    const tableViewIds = existingViews.results.map((v) => v.id)

    // Create the Board view, grouped by Status, sorted by Created descending
    // so latest sessions appear at the top of each column
    await notion.views.create({
      database_id: database.id,
      data_source_id: dataSourceId,
      name: 'Board',
      type: 'board',
      // TODO: SDK types ViewSortRequest as Record<string, never> — may be a bug
      // or the create endpoint may genuinely not support property sorts. If this
      // fails at runtime, move the sort to a views.update() call after creation.
      sorts: [{ property: 'Created', direction: 'descending' }] as any,
      ...(statusPropertyId && {
        configuration: {
          type: 'board' as const,
          group_by: {
            type: 'select' as const,
            property_id: statusPropertyId,
            sort: { type: 'manual' as const },
            hide_empty_groups: false,
          },
          properties: propertiesConfig,
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

/** Ensure an existing board database has all expected properties.
 *  Called once per board at daemon start. Notion merges — existing props
 *  are left alone, missing ones get added. */
export async function ensureBoardSchema({
  notion,
  databaseId,
  clients,
  assigneeField,
}: {
  notion: Client
  databaseId: string
  clients: AcpClient[]
  assigneeField?: boolean
}): Promise<void> {
  const database = await notion.databases.retrieve({ database_id: databaseId }) as DatabaseObjectResponse
  const dataSourceId = database.data_sources?.[0]?.id
  if (!dataSourceId) return

  // Send all expected properties — Notion merges, so existing ones are untouched
  // and missing ones get created.
  const properties = buildBoardProperties({ clients, assigneeField })

  // Remove 'Name' (title property) — can't be added via update, it already exists
  delete properties['Name']

  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: properties as Parameters<Client['dataSources']['update']>[0]['properties'],
  })
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
    icon: { type: 'emoji' as const, emoji: '📋' },
    properties: {
      Name: { title: [{ text: { content: 'Sessions will appear here automatically' } }] },
      Status: { select: { name: 'Not Started' } },
      'Session ID': { rich_text: [{ text: { content: 'example' } }] },
      Repo: { select: { name: 'owner/repo' } },
      Branch: { rich_text: [{ text: { content: 'main' } }] },
      Resume: { rich_text: [{ text: { content: 'opencode --session <id>' } }] },
      Folder: { rich_text: [{ text: { content: '~/projects/repo' } }] },
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
            { type: 'text', text: { content: ' — The git branch name, clickable to open on GitHub.' } },
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
            { type: 'text', text: { content: 'Kimaki' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — Link to the Discord thread (if using kimaki).' } },
          ],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: 'Created / Updated' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' — When the session was first seen and last active.' } },
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
  branch,
  branchUrl,
  shareUrl,
  resumeCommand,
  assigneeId,
  folder,
  kimakiUrl,
  createdAt,
  updatedAt,
  activity,
  icon,
  model,
  firstPrompt,
}: {
  notion: Client
  databaseId: string
  title: string
  sessionId: string
  status: string
  repoSlug: string
  branch?: string
  branchUrl?: string
  shareUrl?: string
  resumeCommand: string
  assigneeId?: string
  folder: string
  kimakiUrl?: string
  createdAt?: string
  updatedAt?: string
  activity?: string
  /** Emoji icon for the page (deterministic per-repo) */
  icon?: string
  /** Model ID used for this session (e.g. "claude-sonnet-4-20250514") */
  model?: string
  /** First user prompt text — shown as a callout block in the page body */
  firstPrompt?: string
}): Promise<string> {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: title } }] },
    Status: { select: { name: status } },
    'Session ID': { rich_text: [{ text: { content: sessionId } }] },
    Repo: { select: { name: repoSlug } },
    Resume: { rich_text: [{ text: { content: resumeCommand } }] },
    Folder: { rich_text: [{ text: { content: folder } }] },
  }

  if (branch) {
    // Rich text with optional clickable link to GitHub branch
    const textObj: { content: string; link?: { url: string } } = { content: branch }
    if (branchUrl) {
      textObj.link = { url: branchUrl }
    }
    properties['Branch'] = { rich_text: [{ text: textObj }] }
  }
  if (shareUrl) {
    properties['Share URL'] = { url: shareUrl }
  }
  if (assigneeId) {
    properties['Assignee'] = { people: [{ id: assigneeId }] }
  }
  if (kimakiUrl) {
    properties['Kimaki'] = { url: kimakiUrl }
  }
  if (createdAt) {
    properties['Created'] = { date: { start: createdAt } }
  }
  if (updatedAt) {
    properties['Updated'] = { date: { start: updatedAt } }
  }
  if (activity) {
    properties['Activity'] = { select: { name: activity } }
  }
  if (model) {
    properties['Model'] = { rich_text: [{ text: { content: model } }] }
  }

  // Build page content blocks — callout with first user prompt
  const children: Parameters<Client['blocks']['children']['append']>[0]['children'] = []
  if (firstPrompt) {
    children.push({
      type: 'callout' as const,
      callout: {
        icon: { type: 'emoji' as const, emoji: '💬' as const },
        color: 'gray_background' as const,
        rich_text: splitRichText(firstPrompt),
      },
    })
  }

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    ...(icon && { icon: { type: 'emoji' as const, emoji: icon } }),
    properties: properties as Parameters<Client['pages']['create']>[0]['properties'],
    ...(children.length > 0 && { children }),
  })

  return page.id
}

export async function updateSessionPage({
  notion,
  pageId,
  title,
  updatedAt,
  shareUrl,
  kimakiUrl,
  activity,
}: {
  notion: Client
  pageId: string
  title?: string
  updatedAt?: string
  shareUrl?: string
  kimakiUrl?: string
  activity?: string
}): Promise<void> {
  const properties: Record<string, unknown> = {}

  if (title) {
    properties['Name'] = { title: [{ text: { content: title } }] }
  }
  if (updatedAt) {
    properties['Updated'] = { date: { start: updatedAt } }
  }
  if (shareUrl) {
    properties['Share URL'] = { url: shareUrl }
  }
  if (kimakiUrl) {
    properties['Kimaki'] = { url: kimakiUrl }
  }
  if (activity) {
    properties['Activity'] = { select: { name: activity } }
  }

  if (Object.keys(properties).length === 0) {
    return
  }

  await notion.pages.update({
    page_id: pageId,
    properties: properties as Parameters<Client['pages']['update']>[0]['properties'],
  })
}

/** Split text into Notion rich_text items (max 2000 chars each). */
function splitRichText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  const MAX_LEN = 2000
  const items: Array<{ type: 'text'; text: { content: string } }> = []
  for (let i = 0; i < text.length; i += MAX_LEN) {
    items.push({ type: 'text', text: { content: text.slice(i, i + MAX_LEN) } })
  }
  // At least one item even for empty text
  if (items.length === 0) {
    items.push({ type: 'text', text: { content: '' } })
  }
  return items
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
