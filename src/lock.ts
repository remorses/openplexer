// Single-instance enforcement via lock port.
// Same pattern as kimaki's hrana-server.ts: probe /health, SIGTERM, SIGKILL.

import http from 'node:http'

const DEFAULT_LOCK_PORT = 29990

export function getLockPort(): number {
  const envPort = process.env['OPENPLEXER_LOCK_PORT']
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10)
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed
    }
  }
  return DEFAULT_LOCK_PORT
}

export async function evictExistingInstance({ port }: { port: number }): Promise<void> {
  const url = `http://127.0.0.1:${port}/health`
  const probe = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => {
    return undefined
  })
  if (!probe) {
    return
  }

  const body = (await probe.json().catch(() => ({}))) as { pid?: number }
  const targetPid = body.pid
  if (!targetPid || targetPid === process.pid) {
    return
  }

  process.kill(targetPid, 'SIGTERM')
  await new Promise((resolve) => {
    setTimeout(resolve, 1000)
  })

  const secondProbe = await fetch(url, { signal: AbortSignal.timeout(500) }).catch(() => {
    return undefined
  })
  if (!secondProbe) {
    return
  }

  process.kill(targetPid, 'SIGKILL')
  await new Promise((resolve) => {
    setTimeout(resolve, 1000)
  })
}

export function startLockServer({ port }: { port: number }): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ pid: process.pid, status: 'ok' }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  server.listen(port, '127.0.0.1')
  return server
}
