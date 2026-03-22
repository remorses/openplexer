// Typed config for openplexer, stored at ~/.openplexer/config.json.
// Supports multiple boards — each board is a separate Notion database
// that this CLI syncs ACP sessions to.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Cached state for a synced session — used for change detection to avoid
 *  redundant Notion API calls. */
export type SyncedSession = {
  pageId: string
  title: string
  updatedAt: string
  shareUrl?: string
  activity?: string
  /** Model ID written to the Model property (for change detection) */
  model?: string
}

export type OpenplexerBoard = {
  /** Notion OAuth access token */
  notionToken: string
  /** Notion OAuth refresh token — used to obtain a new access token when it expires */
  notionRefreshToken: string
  /** Notion user ID of this machine's user */
  notionUserId: string
  /** Notion user name */
  notionUserName: string
  /** Notion workspace ID */
  notionWorkspaceId: string
  /** Notion workspace name */
  notionWorkspaceName: string
  /** Notion page ID where database was created */
  notionPageId: string
  /** Notion database ID (created by CLI) */
  notionDatabaseId: string
  /** Git repo URLs to track (e.g. ["owner/repo1", "owner/repo2"]) */
  trackedRepos: string[]
  /** Map of ACP session ID → synced state */
  syncedSessions: Record<string, SyncedSession>
  /** ISO timestamp of when this board was connected. Only sessions
   *  created or last updated after this time are synced. */
  connectedAt: string
}

export type AcpClient = 'opencode' | 'claude' | 'codex'

export type OpenplexerConfig = {
  /** ACP clients to connect to (user may use both opencode and claude) */
  clients: AcpClient[]
  /** Multiple boards this CLI syncs to */
  boards: OpenplexerBoard[]
  /** Per-repo emoji icon overrides (slug → emoji). Applies globally across all boards. */
  repoIcons?: Record<string, string>
  /** When true, add an Assignee (people) property to the board and set it on
   *  new session pages. Disabled by default because Notion sends a notification
   *  to the assigned user on every page create and there is no API-level way to
   *  suppress it. Enable with `openplexer --assignee`. */
  assigneeField?: boolean
}

const CONFIG_DIR = path.join(os.homedir(), '.openplexer')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function readConfig(): OpenplexerConfig | undefined {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8')
    return JSON.parse(raw) as OpenplexerConfig
  } catch {
    return undefined
  }
}

export function writeConfig(config: OpenplexerConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const tmpFile = CONFIG_FILE + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2))
  fs.renameSync(tmpFile, CONFIG_FILE)
}
