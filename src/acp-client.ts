// Connect to coding agents and list their sessions.
//
// opencode: spawns `opencode serve` and uses the HTTP API's
//   /experimental/session endpoint which returns sessions across ALL
//   projects (Session.listGlobal). The ACP protocol's listSessions
//   calls Session.list which is scoped to a single project — that's
//   why we bypass ACP for opencode.
//
// claude / codex: uses ACP over stdio (unchanged).

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Writable, Readable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type SessionInfo,
} from '@agentclientprotocol/sdk'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type { AcpClient } from './config.ts'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type AgentConnection = {
  client: AcpClient
  listSessions: () => Promise<SessionInfo[]>
  kill: () => void
}

// Keep the old type as an alias for backwards compat in sync.ts
export type AcpConnection = AgentConnection

// ---------------------------------------------------------------------------
// opencode — HTTP server with /experimental/session (global, all projects)
// ---------------------------------------------------------------------------

async function connectOpencode(): Promise<AgentConnection> {
  const PORT = 18_923
  const baseUrl = `http://127.0.0.1:${PORT}`

  // Spawn `opencode serve` on a known port. cwd doesn't matter since
  // we use the global endpoint.
  const child = spawn('opencode', ['serve', '--port', String(PORT)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: '/',
  })

  const sdk = createOpencodeClient({ baseUrl })

  // Wait for the server to be ready (poll until it responds)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/session?limit=1`)
      if (res.ok) break
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  // Verify it's actually up
  const check = await fetch(`${baseUrl}/session?limit=1`).catch(() => null)
  if (!check?.ok) {
    child.kill()
    throw new Error('opencode serve failed to start')
  }

  return {
    client: 'opencode',
    listSessions: async () => {
      const sessions: SessionInfo[] = []
      let cursor: number | undefined

      // Paginate through /experimental/session which uses Session.listGlobal()
      // (returns sessions across ALL projects, not scoped to one)
      while (true) {
        const result = await sdk.experimental.session.list({
          roots: true,
          ...(cursor !== undefined && { cursor }),
        })

        if (result.error || !result.data) {
          throw new Error(`opencode API error: ${result.error}`)
        }

        for (const s of result.data) {
          sessions.push({
            sessionId: s.id,
            cwd: s.directory,
            title: s.title,
            updatedAt: new Date(s.time.updated).toISOString(),
          })
        }

        // Pagination cursor is in the x-next-cursor response header
        const nextCursor = result.response.headers.get('x-next-cursor')
        if (!nextCursor) break
        cursor = Number(nextCursor)
      }

      return sessions
    },
    kill: () => {
      child.kill()
    },
  }
}

// ---------------------------------------------------------------------------
// claude / codex — ACP over stdio
// ---------------------------------------------------------------------------

function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    },
  })
}

function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      nodeStream.on('end', () => {
        controller.close()
      })
      nodeStream.on('error', (err) => {
        controller.error(err)
      })
    },
  })
}

class MinimalClient implements Client {
  async requestPermission() {
    return { outcome: { outcome: 'cancelled' as const } }
  }
  async sessionUpdate() {}
  async readTextFile() {
    return { content: '' }
  }
  async writeTextFile() {
    return {}
  }
}

function resolveAcpBinary(client: 'claude' | 'codex'): { cmd: string; args: string[] } {
  const require = createRequire(import.meta.url)
  const packageName = client === 'claude'
    ? '@zed-industries/claude-agent-acp'
    : '@zed-industries/codex-acp'
  const binName = client === 'claude' ? 'claude-agent-acp' : 'codex-acp'

  const pkgJsonPath = require.resolve(`${packageName}/package.json`)
  const pkgDir = path.dirname(pkgJsonPath)
  const pkg = require(pkgJsonPath) as { bin: string | Record<string, string> }
  const binRelative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[binName]
  const binPath = path.resolve(pkgDir, binRelative)

  return { cmd: process.execPath, args: [binPath] }
}

async function connectAcpAgent(client: 'claude' | 'codex'): Promise<AgentConnection> {
  const { cmd, args } = resolveAcpBinary(client)

  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: '/',
  })

  const stream = ndJsonStream(
    nodeToWebWritable(child.stdin!),
    nodeToWebReadable(child.stdout!),
  )

  const connection = new ClientSideConnection((_agent: Agent) => {
    return new MinimalClient()
  }, stream)

  await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
  })

  return {
    client,
    listSessions: async () => {
      const sessions: SessionInfo[] = []
      let cursor: string | undefined

      while (true) {
        const response = await connection.listSessions({
          ...(cursor ? { cursor } : {}),
        })
        sessions.push(...response.sessions)
        if (!response.nextCursor) break
        cursor = response.nextCursor
      }

      return sessions
    },
    kill: () => {
      child.kill()
    },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function connectAgent({ client }: { client: AcpClient }): Promise<AgentConnection> {
  if (client === 'opencode') {
    return connectOpencode()
  }
  return connectAcpAgent(client)
}

// Legacy exports for backwards compat
export async function connectAcp({ client }: { client: AcpClient }): Promise<AgentConnection> {
  return connectAgent({ client })
}

export async function listAllSessions({
  connection,
}: {
  connection: AgentConnection
}): Promise<SessionInfo[]> {
  return connection.listSessions()
}
