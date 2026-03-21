// Spawn an ACP agent (opencode or claude) as a child process and connect
// as a client via stdio. Uses @agentclientprotocol/sdk for the protocol.

import { spawn } from 'node:child_process'
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

// Minimal Client implementation — we only need session listing,
// not file ops or permissions. requestPermission and sessionUpdate
// are required by the Client interface.
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

// Resolve the ACP binary path for each client. For claude and codex,
// we resolve the bin entry from the installed npm package so they
// don't need to be globally installed or in PATH.
function resolveAcpBinary(client: 'opencode' | 'claude' | 'codex'): { cmd: string; args: string[] } {
  if (client === 'opencode') {
    return { cmd: 'opencode', args: ['acp'] }
  }

  const require = createRequire(import.meta.url)
  const packageName = client === 'claude'
    ? '@zed-industries/claude-code-acp'
    : '@zed-industries/codex-acp'
  const binName = client === 'claude' ? 'claude-code-acp' : 'codex-acp'

  const pkgJsonPath = require.resolve(`${packageName}/package.json`)
  const pkgDir = path.dirname(pkgJsonPath)
  const pkg = require(pkgJsonPath) as { bin: string | Record<string, string> }
  const binRelative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[binName]
  const binPath = path.resolve(pkgDir, binRelative)

  return { cmd: process.execPath, args: [binPath] }
}

export type AcpConnection = {
  connection: ClientSideConnection
  client: 'opencode' | 'claude' | 'codex'
  kill: () => void
}

export async function connectAcp({
  client,
}: {
  client: 'opencode' | 'claude' | 'codex'
}): Promise<AcpConnection> {
  // opencode has a built-in `opencode acp` subcommand.
  // claude and codex use standalone ACP adapter packages installed as
  // dependencies. We resolve the bin path via package.json so they
  // don't need to be in PATH.
  const { cmd, args } = resolveAcpBinary(client)

  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
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
    connection,
    client,
    kill: () => {
      child.kill()
    },
  }
}

export async function listAllSessions({
  connection,
}: {
  connection: ClientSideConnection
}): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = []
  let cursor: string | undefined

  // Paginate through all sessions
  while (true) {
    const response = await connection.listSessions({
      ...(cursor ? { cursor } : {}),
    })
    sessions.push(...response.sessions)
    if (!response.nextCursor) {
      break
    }
    cursor = response.nextCursor
  }

  return sessions
}
