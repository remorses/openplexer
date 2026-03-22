// Core sync loop: polls ACP sessions and syncs them to Notion pages.
// Runs every 5 seconds, creates new pages for untracked sessions,
// updates existing ones when title/updatedAt changes.

import type { OpenplexerBoard, OpenplexerConfig, AcpClient } from './config.ts'
import { writeConfig } from './config.ts'
import { type AgentConnection, type SessionWithParent } from './acp-client.ts'
import { getRepoInfo } from './git.ts'
import {
  createNotionClient,
  createSessionPage,
  updateSessionPage,
  rateLimitedCall,
} from './notion.ts'
import { execFile } from 'node:child_process'
import os from 'node:os'

const SYNC_INTERVAL_MS = 5000

type TaggedSession = SessionWithParent & { source: AcpClient }

export async function startSyncLoop({
  config,
  acpConnections,
}: {
  config: OpenplexerConfig
  acpConnections: AgentConnection[]
}): Promise<void> {
  console.log(`Syncing ${config.boards.length} board(s) every ${SYNC_INTERVAL_MS / 1000}s`)

  const tick = async () => {
    try {
      await syncOnce({ config, acpConnections })
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
  acpConnections,
}: {
  config: OpenplexerConfig
  acpConnections: AgentConnection[]
}): Promise<void> {
  // Collect sessions from all agent connections, tagged with their source
  const sessions: TaggedSession[] = []
  const seenIds = new Set<string>()

  for (const agent of acpConnections) {
    try {
      const clientSessions = await agent.listSessions()
      for (const session of clientSessions) {
        if (!seenIds.has(session.sessionId)) {
          seenIds.add(session.sessionId)
          sessions.push({ ...session, source: agent.client })
        }
      }
    } catch (err) {
      console.error(`Error listing sessions from ${agent.client}:`, err instanceof Error ? err.message : err)
    }
  }

  // Filter out sub-sessions (agent tasks, subtasks) — only sync top-level sessions
  const topLevelSessions = sessions.filter((s) => !s.parentId)

  for (const board of config.boards) {
    await syncBoard({ board, sessions: topLevelSessions })
  }

  // Persist updated syncedSessions
  writeConfig(config)
}

async function syncBoard({
  board,
  sessions,
}: {
  board: OpenplexerBoard
  sessions: TaggedSession[]
}): Promise<void> {
  const notion = createNotionClient({ token: board.notionToken })

  // Filter sessions to tracked repos
  const filteredSessions: Array<{
    session: TaggedSession
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

    const title = session.title || `Session ${session.sessionId.slice(0, 8)}`

    if (existingPageId) {
      // Update existing page
      try {
        await rateLimitedCall(() => {
          return updateSessionPage({
            notion,
            pageId: existingPageId,
            title: session.title || undefined,
            updatedAt: session.updatedAt || undefined,
          })
        })
      } catch (err) {
        console.error(`Error updating "${title}" (${repoSlug}):`, err instanceof Error ? err.message : err)
      }
    } else {
      // Create new page
      const branchUrl = `${repoUrl}/tree/${branch}`
      const resumeCommand = (() => {
        if (session.source === 'opencode') {
          return `opencode --session ${session.sessionId}`
        }
        if (session.source === 'codex') {
          return `codex resume ${session.sessionId}`
        }
        return `claude --resume ${session.sessionId}`
      })()

      // Try to get kimaki Discord URL (only for opencode sessions)
      const kimakiUrl = session.source === 'opencode'
        ? await getKimakiDiscordUrl(session.sessionId)
        : undefined

      // Shorten folder path by replacing homedir with ~
      const folder = (session.cwd || '').replace(os.homedir(), '~')

      try {
        const pageId = await rateLimitedCall(() => {
          return createSessionPage({
            notion,
            databaseId: board.notionDatabaseId,
            title,
            sessionId: session.sessionId,
            status: 'In Progress',
            repoSlug,
            branch,
            branchUrl,
            resumeCommand,
            assigneeId: board.notionUserId,
            folder,
            kimakiUrl: kimakiUrl || undefined,
            createdAt: new Date().toISOString(),
            updatedAt: session.updatedAt || undefined,
          })
        })

        board.syncedSessions[session.sessionId] = pageId
        const notionUrl = `https://notion.so/${pageId.replace(/-/g, '')}`
        console.log(`+ Added "${title}" (${repoSlug}) → ${notionUrl}`)
      } catch (err) {
        console.error(`Error adding "${title}" (${repoSlug}):`, err instanceof Error ? err.message : err)
      }
    }
  }
}

// Try to get kimaki Discord URL for a session via kimaki CLI
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
