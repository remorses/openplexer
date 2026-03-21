// Integration test: verifies that opencode ACP returns sessions from
// multiple different project directories, not just one.
// This test only runs on machines with opencode installed and real sessions.

import { describe, it, expect } from 'vitest'
import { connectAcp, listAllSessions } from './acp-client.ts'

describe('acp-client', () => {
  it('listAllSessions returns sessions from at least 2 different projects', async () => {
    const acp = await connectAcp({ client: 'opencode' })
    try {
      const sessions = await listAllSessions({ connection: acp.connection })

      // Collect unique cwd values
      const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))]

      console.log(`Found ${sessions.length} sessions across ${cwds.length} directories:`)
      for (const cwd of cwds) {
        const count = sessions.filter((s) => s.cwd === cwd).length
        console.log(`  ${cwd}: ${count} sessions`)
      }

      expect(sessions.length).toBeGreaterThan(0)
      expect(cwds.length).toBeGreaterThanOrEqual(2)
    } finally {
      acp.kill()
    }
  }, 30_000)
})
