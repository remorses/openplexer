#!/usr/bin/env node

// openplexer CLI entrypoint.
// Syncs ACP sessions (from OpenCode or Claude Code) to Notion board databases.
// Uses goke for CLI parsing and clack for interactive prompts.

import { goke } from 'goke'
import {
  intro,
  outro,
  text,
  note,
  cancel,
  isCancel,
  confirm,
  log,
  multiselect,
  select,
  spinner,
} from '@clack/prompts'
import crypto from 'node:crypto'
import { exec } from 'node:child_process'
import { readConfig, writeConfig, type OpenplexerConfig, type OpenplexerBoard } from './config.ts'
import { connectAcp, listAllSessions } from './acp-client.ts'
import { getRepoInfo } from './git.ts'
import { createNotionClient, createBoardDatabase } from './notion.ts'
import { evictExistingInstance, getLockPort, startLockServer } from './lock.ts'
import { startSyncLoop } from './sync.ts'

const OPENPLEXER_URL = 'https://openplexer.com'

const cli = goke('openplexer')

// Default command: start sync if boards exist, otherwise run connect wizard
cli
  .command('', 'Sync coding sessions to Notion boards')
  .action(async () => {
    const config = readConfig()
    if (!config || config.boards.length === 0) {
      await connectFlow()
      return
    }
    await startDaemon(config)
  })

// Connect command: add a new board
cli.command('connect', 'Connect a new Notion board').action(async () => {
  await connectFlow()
})

// Status command: show current sync state
cli.command('status', 'Show sync state').action(async () => {
  const config = readConfig()
  if (!config || config.boards.length === 0) {
    console.log('No boards configured. Run `openplexer connect` to add one.')
    return
  }
  console.log(`Client: ${config.client}`)
  console.log(`Boards: ${config.boards.length}`)
  config.boards.forEach((board, i) => {
    console.log(
      `  ${i + 1}. ${board.notionWorkspaceName} — ${board.trackedRepos.length} repos, ${Object.keys(board.syncedSessions).length} synced sessions`,
    )
  })
})

// Stop command: kill running daemon via lock port
cli.command('stop', 'Stop the running openplexer daemon').action(async () => {
  const port = getLockPort()
  const probe = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(1000),
  }).catch(() => {
    return undefined
  })

  if (!probe) {
    console.log('No running daemon found.')
    return
  }

  const body = (await probe.json().catch(() => ({}))) as { pid?: number }
  if (body.pid) {
    process.kill(body.pid, 'SIGTERM')
    console.log(`Stopped daemon (PID ${body.pid})`)
  }
})

// Boards command: list boards
cli.command('boards', 'List configured boards').action(async () => {
  const config = readConfig()
  if (!config || config.boards.length === 0) {
    console.log('No boards configured.')
    return
  }
  config.boards.forEach((board, i) => {
    console.log(`${i + 1}. ${board.notionWorkspaceName}`)
    console.log(`   Page: https://notion.so/${board.notionPageId.replace(/-/g, '')}`)
    console.log(`   Repos: ${board.trackedRepos.join(', ') || '(all)'}`)
    console.log(`   Synced: ${Object.keys(board.syncedSessions).length} sessions`)
  })
})

cli.parse()

// --- Connect wizard ---

async function connectFlow(): Promise<void> {
  intro('openplexer — connect a Notion board')

  const config = readConfig() || ({ client: 'opencode', boards: [] } as OpenplexerConfig)

  // Step 1: Choose ACP client (only on first run)
  if (config.boards.length === 0) {
    const clientChoice = await select({
      message: 'Which coding agent do you use?',
      options: [
        { value: 'opencode' as const, label: 'OpenCode' },
        { value: 'claude' as const, label: 'Claude Code' },
      ],
    })
    if (isCancel(clientChoice)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
    config.client = clientChoice
  }

  // Step 2: Spawn ACP and discover projects
  const s = spinner()
  s.start(`Connecting to ${config.client}...`)

  let repoSlugs: string[] = []
  try {
    const acp = await connectAcp({ client: config.client })
    const sessions = await listAllSessions({ connection: acp.connection })
    s.stop(`Found ${sessions.length} sessions`)

    // Extract unique repos from session cwds
    const cwds = [...new Set(sessions.map((sess) => sess.cwd).filter(Boolean))] as string[]
    const repoInfos = await Promise.all(cwds.map((cwd) => getRepoInfo({ cwd })))
    repoSlugs = [...new Set(repoInfos.filter(Boolean).map((r) => r!.slug))]

    acp.kill()
  } catch (err) {
    s.stop('Failed to connect to ACP')
    log.error(
      `Could not connect to ${config.client}. Make sure "${config.client}" is installed and in PATH.`,
    )
    process.exit(1)
  }

  // Step 3: Select repos to track
  let trackedRepos: string[] = []
  if (repoSlugs.length > 0) {
    note(
      'Select specific repos if you plan to collaborate.\nThis avoids showing personal projects on the shared board.',
      'Repo selection',
    )
    const repoChoice = await multiselect({
      message: 'Which repos to track?',
      options: repoSlugs.map((slug) => ({
        value: slug,
        label: slug,
      })),
      required: false,
    })
    if (isCancel(repoChoice)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
    trackedRepos = repoChoice
  } else {
    log.warn('No git repos found in sessions. All future sessions will be tracked.')
  }

  // Step 4: Notion OAuth
  const state = crypto.randomBytes(16).toString('hex')
  const authUrl = `${OPENPLEXER_URL}/auth/notion?state=${state}`

  note(`Opening browser to connect Notion.\nAuthorize the integration and select a page to share.\n\n${authUrl}`, 'Notion')

  // Open browser
  const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  exec(`${openCmd} "${authUrl}"`)

  s.start('Waiting for Notion authorization...')

  // Poll for token
  type AuthResult = {
    accessToken: string
    botId: string
    workspaceId: string
    workspaceName: string
    notionUserId?: string
    notionUserName?: string
  }
  let authResult: AuthResult | undefined
  const maxAttempts = 150 // 5 minutes at 2s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 2000)
    })
    const resp = await fetch(`${OPENPLEXER_URL}/auth/status?state=${state}`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => {
      return undefined
    })
    if (resp?.ok) {
      authResult = (await resp.json()) as AuthResult
      break
    }
  }

  if (!authResult) {
    s.stop('Timed out waiting for Notion authorization')
    process.exit(1)
  }

  s.stop(`Connected to ${authResult.workspaceName}`)

  // Step 5: Select Notion page
  const pageInput = await text({
    message: 'Paste the Notion page URL where the board should be created:',
    placeholder: 'https://www.notion.so/Your-Page-Title-abc123...',
    validate(value) {
      if (!value.includes('notion.so')) {
        return 'Must be a Notion URL'
      }
    },
  })
  if (isCancel(pageInput)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  // Extract page ID from URL — Notion URLs end with a 32-char hex ID
  const pageIdMatch = pageInput.match(/([a-f0-9]{32})(?:\?|$)/i) || pageInput.match(/([a-f0-9-]{36})(?:\?|$)/i)
  if (!pageIdMatch) {
    log.error('Could not extract page ID from URL')
    process.exit(1)
  }
  const pageId = pageIdMatch[1]

  note('Make this page private if you don\'t want others reading session info.', 'Privacy')

  // Step 6: Create database
  s.start('Creating board database...')
  const notion = createNotionClient({ token: authResult.accessToken })
  const { databaseId } = await createBoardDatabase({ notion, pageId })
  s.stop('Board database created')

  log.success('Open the database in Notion and click "+ Add a view" → Board, grouped by Status.')

  // Step 7: Save to config
  const board: OpenplexerBoard = {
    notionToken: authResult.accessToken,
    notionUserId: authResult.notionUserId || '',
    notionUserName: authResult.notionUserName || '',
    notionWorkspaceId: authResult.workspaceId,
    notionWorkspaceName: authResult.workspaceName,
    notionPageId: pageId,
    notionDatabaseId: databaseId,
    trackedRepos,
    syncedSessions: {},
    connectedAt: new Date().toISOString(),
  }

  config.boards.push(board)
  writeConfig(config)

  // Step 8: Offer startup registration
  const registerStartup = await confirm({
    message: 'Register openplexer to run on startup?',
  })
  if (!isCancel(registerStartup) && registerStartup) {
    log.info('Startup registration not yet implemented. Run `openplexer` manually for now.')
  }

  outro('Board connected! Run `openplexer` to start syncing.')
}

// --- Daemon ---

async function startDaemon(config: OpenplexerConfig): Promise<void> {
  const port = getLockPort()
  await evictExistingInstance({ port })
  startLockServer({ port })

  console.log(`openplexer daemon started (PID ${process.pid}, port ${port})`)

  const acp = await connectAcp({ client: config.client })
  console.log(`Connected to ${config.client} via ACP`)

  await startSyncLoop({ config, acpConnection: acp.connection })
}
