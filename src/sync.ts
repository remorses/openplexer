// Core sync loop: polls ACP sessions and syncs them to Notion pages.
// Runs every 5 seconds, creates new pages for untracked sessions,
// updates existing ones when title/updatedAt changes.

import type { ClientSideConnection, SessionInfo } from '@agentclientprotocol/sdk'
import type { Client } from '@notionhq/client'
import type { OpenplexerBoard, OpenplexerConfig } from './config.ts'
import { writeConfig } from './config.ts'
import { listAllSessions } from './acp-client.ts'
import { getRepoInfo } from './git.ts'
import {
  createNotionClient,
  createSessionPage,
  updateSessionPage,
  rateLimitedCall,
} from './notion.ts'
import { execFile } from 'node:child_process'

const SYNC_INTERVAL_MS = 5000

export async function startSyncLoop({
  config,
  acpConnection,
}: {
  config: OpenplexerConfig
  acpConnection: ClientSideConnection
}): Promise<void> {
  console.log(`Syncing ${config.boards.length} board(s) every ${SYNC_INTERVAL_MS / 1000}s`)

  const tick = async () => {
    try {
      await syncOnce({ config, acpConnection })
    } catch (err) {
      console.error('Sync error:', err)
    }
  }

  // Initial sync
  await tick()

  // Then every 5 seconds
  setInterval(tick, SYNC_INTERVAL_MS)
}

async function syncOnce({
  config,
  acpConnection,
}: {
  config: OpenplexerConfig
  acpConnection: ClientSideConnection
}): Promise<void> {
  const sessions = await listAllSessions({ connection: acpConnection })

  for (const board of config.boards) {
    await syncBoard({ config, board, sessions })
  }

  // Persist updated syncedSessions
  writeConfig(config)
}

async function syncBoard({
  config,
  board,
  sessions,
}: {
  config: OpenplexerConfig
  board: OpenplexerBoard
  sessions: SessionInfo[]
}): Promise<void> {
  const notion = createNotionClient({ token: board.notionToken })

  // Filter sessions to tracked repos
  const filteredSessions: Array<{
    session: SessionInfo
    repoSlug: string
    repoUrl: string
    branch: string
  }> = []

  const connectedAtMs = new Date(board.connectedAt).getTime()

  for (const session of sessions) {
    if (!session.cwd) {
      continue
    }
    // Skip sessions that predate board creation (unless already synced)
    if (!board.syncedSessions[session.sessionId]) {
      const updatedAtMs = session.updatedAt ? new Date(session.updatedAt).getTime() : 0
      if (updatedAtMs < connectedAtMs) {
        continue
      }
    }
    const repo = await getRepoInfo({ cwd: session.cwd })
    if (!repo) {
      continue
    }
    // If trackedRepos is empty, track all repos
    if (board.trackedRepos.length > 0 && !board.trackedRepos.includes(repo.slug)) {
      continue
    }
    filteredSessions.push({
      session,
      repoSlug: repo.slug,
      repoUrl: repo.url,
      branch: repo.branch,
    })
  }

  // Sync each session
  for (const { session, repoSlug, repoUrl, branch } of filteredSessions) {
    const existingPageId = board.syncedSessions[session.sessionId]

    if (existingPageId) {
      // Update existing page
      await rateLimitedCall(() => {
        return updateSessionPage({
          notion,
          pageId: existingPageId,
          title: session.title || undefined,
          updatedAt: session.updatedAt || undefined,
        })
      })
    } else {
      // Create new page
      const title = session.title || `Session ${session.sessionId.slice(0, 8)}`
      const branchUrl = `${repoUrl}/tree/${branch}`
      const resumeCommand = (() => {
        if (config.client === 'opencode') {
          return `opencode --session ${session.sessionId}`
        }
        return `claude --resume ${session.sessionId}`
      })()

      // Try to get Discord URL if kimaki is available
      const discordUrl = await getKimakiDiscordUrl(session.sessionId)

      const pageId = await rateLimitedCall(() => {
        return createSessionPage({
          notion,
          databaseId: board.notionDatabaseId,
          title,
          sessionId: session.sessionId,
          status: 'In Progress',
          repoSlug,
          branchUrl,
          resumeCommand,
          assigneeId: board.notionUserId,
          folder: session.cwd || '',
          discordUrl: discordUrl || undefined,
          updatedAt: session.updatedAt || undefined,
        })
      })

      board.syncedSessions[session.sessionId] = pageId
      console.log(`  + ${title} (${repoSlug})`)
    }
  }
}

// Try to get Discord URL for a session via kimaki CLI
async function getKimakiDiscordUrl(sessionId: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'kimaki',
      ['session', 'discord-url', '--json', sessionId],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        try {
          const data = JSON.parse(stdout.trim()) as { url?: string }
          resolve(data.url)
        } catch {
          resolve(undefined)
        }
      },
    )
  })
}
