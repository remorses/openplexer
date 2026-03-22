// Core sync loop: polls ACP sessions and syncs them to Notion pages.
// Runs every 5 seconds, creates new pages for untracked sessions,
// updates existing ones when title/updatedAt changes.

import * as errore from 'errore'
import type { OpenplexerBoard, OpenplexerConfig, AcpClient } from './config.ts'
import { writeConfig } from './config.ts'
import { type AgentConnection, type Session } from './acp-client.ts'
import { getRepoInfo } from './git.ts'
import {
  createNotionClient,
  createSessionPage,
  updateSessionPage,
  ensureBoardSchema,
  rateLimitedCall,
} from './notion.ts'
import { resolveRepoIcon } from './emoji.ts'
import { APIResponseError } from '@notionhq/client'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { createSpiceflowFetch } from 'spiceflow/client'
import type { App } from './worker.ts'

class NotionUnauthorizedError extends errore.createTaggedError({
  name: 'NotionUnauthorizedError',
  message: 'Notion token expired for $board',
}) {}

class TokenRefreshError extends errore.createTaggedError({
  name: 'TokenRefreshError',
  message: 'Failed to refresh token for $board: $reason',
}) {}

class NotionApiError extends errore.createTaggedError({
  name: 'NotionApiError',
  message: 'Notion API call failed for $operation',
}) {}

class AgentError extends errore.createTaggedError({
  name: 'AgentError',
  message: 'Error listing sessions from $client',
}) {}

const execFileAsync = promisify(execFile)

const SYNC_INTERVAL_MS = 5000
const OPENPLEXER_URL = 'https://openplexer.com'
const apiFetch = createSpiceflowFetch<App>(OPENPLEXER_URL)

// Track sessions that were created without a kimaki URL so we can retry
// on subsequent sync ticks. We stop retrying after KIMAKI_RETRY_WINDOW_MS
// to avoid calling `kimaki session discord-url` forever for sessions that
// genuinely don't have a Discord thread (e.g. started from terminal).
const KIMAKI_RETRY_WINDOW_MS = 2 * 60 * 1000 // 2 minutes
const sessionKimakiState = new Map<string, { createdAt: number; hasKimakiUrl: boolean }>()

// In-memory cache: cwd → stable repo identity (slug + url). Branch is NOT
// cached because it can change (user switches branches, new sessions on
// different branches sharing the same cwd). Branch is resolved fresh only
// for new session creates where K is low.
const repoCache = new Map<string, { slug: string; url: string }>()

type TaggedSession = Session & {
  source: AcpClient
  getShareUrl?: (sessionId: string) => Promise<string | undefined>
  getFirstMessage?: (sessionId: string) => Promise<{ prompt?: string; model?: string } | undefined>
}



export async function startSyncLoop({
  config,
  acpConnections,
}: {
  config: OpenplexerConfig
  acpConnections: AgentConnection[]
}): Promise<void> {
  console.log(`Syncing ${config.boards.length} board(s) every ${SYNC_INTERVAL_MS / 1000}s`)

  // Ensure all boards have the latest property schema (adds missing props
  // like Activity to boards created before that feature existed)
  for (const board of config.boards) {
    const schemaResult = await ensureBoardSchema({
      notion: createNotionClient({ token: board.notionToken }),
      databaseId: board.notionDatabaseId,
      clients: config.clients,
      assigneeField: config.assigneeField,
    }).catch((e) => {
      if (e instanceof APIResponseError && e.status === 401)
        return new NotionUnauthorizedError({ board: board.notionWorkspaceName, cause: e })
      return new NotionApiError({ operation: 'ensure schema', cause: e })
    })

    if (schemaResult instanceof NotionUnauthorizedError) {
      console.warn(`Token expired for ${board.notionWorkspaceName} during schema check, refreshing...`)
      const refreshResult = await refreshBoardToken({ board, config })
      if (refreshResult instanceof Error) {
        console.error(refreshResult.message)
        continue
      }
      // Retry with new token
      const retryResult = await ensureBoardSchema({
        notion: createNotionClient({ token: board.notionToken }),
        databaseId: board.notionDatabaseId,
        clients: config.clients,
        assigneeField: config.assigneeField,
      }).catch((e) => new NotionApiError({ operation: 'ensure schema (retry)', cause: e }))
      if (retryResult instanceof Error) {
        console.error(`Schema ensure failed after refresh for ${board.notionWorkspaceName}:`, retryResult.message)
      }
      continue
    }

    if (schemaResult instanceof Error) {
      console.error(`Schema ensure failed for ${board.notionWorkspaceName}:`, schemaResult.message)
    }
  }

  const tick = async () => {
    try {
      await syncOnce({ config, acpConnections })
    } catch (err) {
      console.error('Sync error:', err)
    }
  }

  // Initial sync
  await tick()

  // Schedule next tick after previous finishes (prevents overlap when
  // a tick takes longer than SYNC_INTERVAL_MS due to rate limiting)
  const scheduleNext = () => {
    setTimeout(async () => {
      await tick()
      scheduleNext()
    }, SYNC_INTERVAL_MS)
  }
  scheduleNext()
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
    const clientSessions = await agent.listSessions()
      .catch((e) => new AgentError({ client: agent.client, cause: e }))
    if (clientSessions instanceof Error) {
      console.error(clientSessions.message)
      continue
    }
    for (const session of clientSessions) {
      if (!seenIds.has(session.sessionId)) {
        seenIds.add(session.sessionId)
        sessions.push({ ...session, source: agent.client, getShareUrl: agent.getShareUrl, getFirstMessage: agent.getFirstMessage })
      }
    }
  }

  // Filter out sub-sessions (agent tasks, subtasks) — only sync top-level sessions
  const topLevelSessions = sessions.filter((s) => !s.parentId)

  let dirty = false
  for (const board of config.boards) {
    const result = await syncBoard({ board, sessions: topLevelSessions, repoIcons: config.repoIcons, assigneeField: config.assigneeField })

    if (result instanceof NotionUnauthorizedError) {
      console.warn(`Token expired for ${board.notionWorkspaceName}, refreshing...`)
      const refreshResult = await refreshBoardToken({ board, config })
      if (refreshResult instanceof Error) {
        console.error(refreshResult.message)
        continue
      }
      // Retry once with the new token
      const retryResult = await syncBoard({ board, sessions: topLevelSessions, repoIcons: config.repoIcons, assigneeField: config.assigneeField })
      if (retryResult instanceof Error) {
        console.error(`Sync failed after token refresh for ${board.notionWorkspaceName}:`, retryResult.message)
        continue
      }
      if (retryResult) dirty = true
      continue
    }

    if (result === true) dirty = true
  }

  // Only write config to disk when something actually changed
  if (dirty) {
    writeConfig(config)
  }
}

/** Returns true if any Notion pages were created or updated (config is dirty).
 *  Returns NotionUnauthorizedError if a 401 is hit (caller should refresh token). */
async function syncBoard({
  board,
  sessions,
  repoIcons,
  assigneeField,
}: {
  board: OpenplexerBoard
  sessions: TaggedSession[]
  repoIcons?: Record<string, string>
  assigneeField?: boolean
}): Promise<NotionUnauthorizedError | boolean> {
  const notion = createNotionClient({ token: board.notionToken })
  let dirty = false

  // Filter sessions to tracked repos (using cached slug/url, no branch yet)
  const filteredSessions: Array<{
    session: TaggedSession
    repoSlug: string
    repoUrl: string
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
    // Use cached repo identity — git remote doesn't change during daemon lifetime
    const repo = repoCache.get(session.cwd) ?? await (async () => {
      const resolved = await getRepoInfo({ cwd: session.cwd })
      if (!resolved) return undefined
      const entry = { slug: resolved.slug, url: resolved.url }
      repoCache.set(session.cwd!, entry)
      return entry
    })()
    if (!repo) continue
    // If trackedRepos is empty, track all repos
    if (board.trackedRepos.length > 0 && !board.trackedRepos.includes(repo.slug)) {
      continue
    }
    filteredSessions.push({
      session,
      repoSlug: repo.slug,
      repoUrl: repo.url,
    })
  }

  // Sync each session
  for (const { session, repoSlug, repoUrl } of filteredSessions) {
    const cached = board.syncedSessions[session.sessionId]

    // Use the same normalized title for both comparison and caching to avoid
    // false positives on untitled sessions (create caches fallback, update compares raw)
    const title = session.title || `Session ${session.sessionId.slice(0, 8)}`

    // Resolve share URL: use cached value from listSessions, or auto-share via SDK
    const shareUrl = session.shareUrl ?? await session.getShareUrl?.(session.sessionId)

    if (cached) {
      // --- Existing session: only update if something changed ---

      // Retry kimaki URL for sessions that were created without one
      // (race condition: openplexer sees the session before kimaki writes the thread association)
      const kimakiKey = `${board.notionDatabaseId}:${session.sessionId}`
      const kimakiUrl = await (async (): Promise<string | undefined> => {
        if (session.source !== 'opencode') return undefined
        const state = sessionKimakiState.get(kimakiKey)
        if (!state || state.hasKimakiUrl) return undefined
        if (Date.now() - state.createdAt >= KIMAKI_RETRY_WINDOW_MS) return undefined
        const url = await getKimakiDiscordUrl(session.sessionId)
        if (url) state.hasKimakiUrl = true
        return url
      })()

      // Compare with cached state — skip Notion API call if nothing changed
      const newUpdatedAt = session.updatedAt || ''
      const newActivity = session.activity
      const titleChanged = title !== cached.title
      const updatedAtChanged = newUpdatedAt !== cached.updatedAt
      const hasKimakiUpdate = !!kimakiUrl
      const hasShareUrlUpdate = !!shareUrl && shareUrl !== cached.shareUrl
      const activityChanged = !!newActivity && newActivity !== cached.activity

      if (!titleChanged && !updatedAtChanged && !hasKimakiUpdate && !hasShareUrlUpdate && !activityChanged) {
        continue
      }

      // Update existing page
      const updateResult = await rateLimitedCall(() =>
        updateSessionPage({
          notion,
          pageId: cached.pageId,
          title: session.title || undefined,
          updatedAt: session.updatedAt || undefined,
          shareUrl: hasShareUrlUpdate ? shareUrl : undefined,
          kimakiUrl,
          activity: activityChanged ? newActivity : undefined,
        }),
      ).catch((e) => {
        if (e instanceof APIResponseError && e.status === 401)
          return new NotionUnauthorizedError({ board: board.notionWorkspaceName, cause: e })
        return new NotionApiError({ operation: 'update session', cause: e })
      })

      if (updateResult instanceof NotionUnauthorizedError) return updateResult
      if (updateResult instanceof Error) {
        console.error(`Error updating "${title}" (${repoSlug}):`, updateResult.message)
        continue
      }

      // Update cached state so next tick can skip if unchanged
      board.syncedSessions[session.sessionId] = {
        pageId: cached.pageId,
        title,
        updatedAt: newUpdatedAt,
        shareUrl: shareUrl ?? cached.shareUrl,
        activity: newActivity ?? cached.activity,
        model: cached.model,
      }
      dirty = true
    } else {
      // --- New session: create page ---
      // Resolve branch fresh (not cached — can change between sessions in same cwd)
      const freshRepo = await getRepoInfo({ cwd: session.cwd! })
      const branch = freshRepo?.branch ?? 'main'
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

      // Fetch first user message (prompt + model) from agent — only available for opencode
      const firstMsg = await session.getFirstMessage?.(session.sessionId).catch(() => undefined)

      const pageId = await rateLimitedCall(() =>
        createSessionPage({
          notion,
          databaseId: board.notionDatabaseId,
          title,
          sessionId: session.sessionId,
          status: 'In Progress',
          repoSlug,
          branch,
          branchUrl,
          resumeCommand,
          assigneeId: assigneeField ? board.notionUserId : undefined,
          folder,
          shareUrl,
          kimakiUrl: kimakiUrl || undefined,
          createdAt: new Date().toISOString(),
          updatedAt: session.updatedAt || undefined,
          activity: session.activity,
          icon: resolveRepoIcon({ slug: repoSlug, branch, repoIcons }),
          model: firstMsg?.model,
          firstPrompt: firstMsg?.prompt,
        }),
      ).catch((e) => {
        if (e instanceof APIResponseError && e.status === 401)
          return new NotionUnauthorizedError({ board: board.notionWorkspaceName, cause: e })
        return new NotionApiError({ operation: 'create session', cause: e })
      })

      if (pageId instanceof NotionUnauthorizedError) return pageId
      if (pageId instanceof Error) {
        console.error(`Error adding "${title}" (${repoSlug}):`, pageId.message)
        continue
      }

      board.syncedSessions[session.sessionId] = {
        pageId,
        title,
        updatedAt: session.updatedAt ?? '',
        shareUrl: shareUrl ?? '',
        activity: session.activity,
        model: firstMsg?.model,
      }
      sessionKimakiState.set(`${board.notionDatabaseId}:${session.sessionId}`, {
        createdAt: Date.now(),
        hasKimakiUrl: !!kimakiUrl,
      })
      dirty = true
      const notionUrl = `https://notion.so/${pageId.replace(/-/g, '')}`
      console.log(`+ Added "${title}" (${repoSlug}) → ${notionUrl}`)
    }
  }

  return dirty
}

/** Refresh a board's Notion access token via the openplexer worker.
 *  Updates the board in-place and writes config to disk.
 *  Returns TokenRefreshError on failure, void on success. */
async function refreshBoardToken({
  board,
  config,
}: {
  board: OpenplexerBoard
  config: OpenplexerConfig
}) {
  if (!board.notionRefreshToken) {
    return new TokenRefreshError({ board: board.notionWorkspaceName, reason: 'no refresh token saved' })
  }

  const data = await apiFetch('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: board.notionRefreshToken },
    signal: AbortSignal.timeout(10_000),
  })

  if (data instanceof Error) {
    const err = data as Error & { status?: number; value?: unknown }
    const detail = err.status != null
      ? `HTTP ${err.status}: ${String(err.value ?? err.message)}`
      : err.message
    return new TokenRefreshError({ board: board.notionWorkspaceName, reason: detail, cause: data })
  }

  if (!data.accessToken || !data.refreshToken) {
    return new TokenRefreshError({ board: board.notionWorkspaceName, reason: 'server returned empty tokens' })
  }

  board.notionToken = data.accessToken
  board.notionRefreshToken = data.refreshToken
  writeConfig(config)
  console.log(`Refreshed Notion token for ${board.notionWorkspaceName}`)
}

// Try to get kimaki Discord URL for a session via kimaki CLI.
// Returns undefined when kimaki isn't installed, the session has no thread,
// or the command/parse fails — all expected cases during normal operation.
async function getKimakiDiscordUrl(sessionId: string) {
  const result = await execFileAsync(
    'kimaki',
    ['session', 'discord-url', '--json', sessionId],
    { timeout: 3000 },
  ).catch(() => undefined)
  if (!result) return undefined

  // kimaki may print log lines before the JSON object — find the line starting with '{'
  const jsonLine = result.stdout.split('\n').find((line) => line.trimStart().startsWith('{'))
  if (!jsonLine) {
    console.warn(`kimaki discord-url: no JSON line found for session ${sessionId}`)
    return undefined
  }
  const parsed = errore.try({
    try: () => JSON.parse(jsonLine) as { url?: string },
    catch: (e) => new Error('Invalid JSON', { cause: e }),
  })
  if (parsed instanceof Error) {
    console.warn(`kimaki discord-url: invalid JSON for session ${sessionId}`)
    return undefined
  }
  return parsed.url
}
