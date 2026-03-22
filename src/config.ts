// Typed config for openplexer, stored at ~/.openplexer/config.json.
// Supports multiple boards — each board is a separate Notion database
// that this CLI syncs ACP sessions to.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export type OpenplexerBoard = {
  /** Notion OAuth access token */
  notionToken: string
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
  /** Map of ACP session ID → Notion page ID (already synced) */
  syncedSessions: Record<string, string>
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
