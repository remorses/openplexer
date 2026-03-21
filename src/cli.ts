#!/usr/bin/env node

// openplexer CLI entrypoint.
// Syncs ACP sessions (from OpenCode or Claude Code) to Notion board databases.
// Uses goke for CLI parsing and clack for interactive prompts.

import { goke } from 'goke'
import {
  intro,
  outro,
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
import path from 'node:path'
import { exec } from 'node:child_process'
import { readConfig, writeConfig, type OpenplexerConfig, type OpenplexerBoard, type AcpClient } from './config.ts'
import { connectAcp, listAllSessions, type AcpConnection } from './acp-client.ts'
import { getRepoInfo } from './git.ts'
import { createNotionClient, createBoardDatabase, getRootPages } from './notion.ts'
import { evictExistingInstance, getLockPort, startLockServer } from './lock.ts'
import { startSyncLoop } from './sync.ts'
import {
  enableStartupService,
  disableStartupService,
  isStartupServiceEnabled,
  getServiceLocationDescription,
} from './startup-service.ts'

const OPENPLEXER_URL = 'https://openplexer.com'

process.title = 'openplexer'

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
  console.log(`Clients: ${config.clients.join(', ')}`)
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

// Startup command: manage startup registration
cli.command('startup', 'Show startup registration status').action(async () => {
  const enabled = await isStartupServiceEnabled()
  if (enabled) {
    console.log(`Registered: ${getServiceLocationDescription()}`)
  } else {
    console.log('Not registered to run on login.')
  }
})

cli
  .command('startup enable', 'Register openplexer to run on login')
  .action(async () => {
    const openplexerBin = path.resolve(process.argv[1])
    await enableStartupService({ command: process.execPath, args: [openplexerBin] })
    console.log(`Registered at ${getServiceLocationDescription()}`)
  })

cli
  .command('startup disable', 'Unregister openplexer from login')
  .action(async () => {
    await disableStartupService()
    console.log('Unregistered from login startup.')
  })

cli.parse()

// --- Connect wizard ---

async function connectFlow(): Promise<void> {
  intro('openplexer — connect a Notion board')

  const config = readConfig() || ({ clients: [], boards: [] } as OpenplexerConfig)

  // Step 1: Choose ACP clients (only on first run)
  if (config.clients.length === 0) {
    const clientChoice = await multiselect({
      message: 'Which coding agents do you use?',
      options: [
        { value: 'opencode' as const, label: 'OpenCode' },
        { value: 'claude' as const, label: 'Claude Code' },
        { value: 'codex' as const, label: 'Codex' },
      ],
      required: true,
    })
    if (isCancel(clientChoice)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
    config.clients = clientChoice
  }

  // Step 2: Spawn ACP for each client and discover projects
  const s = spinner()
  const clientLabel = config.clients.join(' + ')
  s.start(`Connecting to ${clientLabel}...`)

  let repoSlugs: string[] = []
  const connectedClients: AcpClient[] = []

  for (const client of config.clients) {
    try {
      const acp = await connectAcp({ client })
      const sessions = await listAllSessions({ connection: acp.connection })

      // Extract unique repos from session cwds
      const cwds = [...new Set(sessions.map((sess) => sess.cwd).filter(Boolean))] as string[]
      const repoInfos = await Promise.all(cwds.map((cwd) => getRepoInfo({ cwd })))
      repoSlugs.push(...repoInfos.filter(Boolean).map((r) => r!.slug))

      acp.kill()
      connectedClients.push(client)
      log.info(`${client}: ${sessions.length} sessions`)
    } catch {
      log.warn(`Could not connect to ${client}. Make sure "${client}" is installed and in PATH.`)
    }
  }

  repoSlugs = [...new Set(repoSlugs)]
  s.stop(`Found ${repoSlugs.length} repos from ${connectedClients.join(' + ')}`)

  if (connectedClients.length === 0) {
    log.error('Could not connect to any ACP agent.')
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
      options: [
        { value: '*', label: '* All repos', hint: 'sync every repo with a git remote' },
        ...repoSlugs.map((slug) => ({
          value: slug,
          label: slug,
        })),
      ],
      required: false,
    })
    if (isCancel(repoChoice)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
    trackedRepos = repoChoice.includes('*') ? [] : repoChoice
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

  // Step 5: Select Notion page from root pages
  const notion = createNotionClient({ token: authResult.accessToken })
  s.start('Fetching Notion pages...')
  const rootPages = await getRootPages({ notion })
  s.stop(`Found ${rootPages.length} root pages`)

  if (rootPages.length === 0) {
    log.error('No root pages found in your Notion workspace. Create a page first.')
    process.exit(1)
  }

  // Filter out pages already used by other boards
  const usedPageIds = new Set(config.boards.map((b) => b.notionPageId))
  const availablePages = rootPages.filter((p) => !usedPageIds.has(p.id))

  if (availablePages.length === 0) {
    log.error('All root pages are already connected to boards.')
    process.exit(1)
  }

  const pageId: string = await (async () => {
    if (availablePages.length === 1) {
      log.info(`Auto-selected page: ${availablePages[0].icon} ${availablePages[0].title}`)
      return availablePages[0].id
    }
    const pageChoice = await select({
      message: 'Which Notion page should hold the board?',
      options: availablePages.map((p) => ({
        value: p.id,
        label: `${p.icon} ${p.title}`.trim(),
        hint: usedPageIds.has(p.id) ? 'already used' : undefined,
      })),
    })
    if (isCancel(pageChoice)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
    return pageChoice
  })()

  // Step 6: Create database
  s.start('Creating board database...')
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

  // Resolve absolute path to the CLI script so startup service and
  // detached spawn work regardless of cwd at login/invocation time.
  const openplexerBin = path.resolve(process.argv[1])

  // Step 8: Offer startup registration
  const alreadyEnabled = await isStartupServiceEnabled()
  if (!alreadyEnabled) {
    const registerStartup = await confirm({
      message: 'Register openplexer to run on login?',
    })
    if (!isCancel(registerStartup) && registerStartup) {
      await enableStartupService({ command: process.execPath, args: [openplexerBin] })
      log.success(`Registered at ${getServiceLocationDescription()}`)
    }
  } else {
    log.info(`Already registered at ${getServiceLocationDescription()}`)
  }

  outro('Board connected! Starting sync, keep this process running.')

  // Transition directly into the sync daemon instead of spawning a child
  await startDaemon(config)
}

// --- Daemon ---

async function startDaemon(config: OpenplexerConfig): Promise<void> {
  const port = getLockPort()
  await evictExistingInstance({ port })
  startLockServer({ port })

  console.log(`openplexer daemon started (PID ${process.pid}, port ${port})`)

  const connections: AcpConnection[] = []
  for (const client of config.clients) {
    try {
      const acp = await connectAcp({ client })
      connections.push(acp)
      console.log(`Connected to ${client} via ACP`)
    } catch {
      console.error(`Failed to connect to ${client}, skipping`)
    }
  }

  if (connections.length === 0) {
    console.error('Could not connect to any ACP agent.')
    process.exit(1)
  }

  await startSyncLoop({ config, acpConnections: connections })
}
