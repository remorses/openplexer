// Integration test: verifies that opencode returns sessions from
// multiple different project directories, not just one.
// This test only runs on machines with opencode installed and real sessions.

import { describe, it, expect } from 'vitest'
import { connectAgent } from './acp-client.ts'
import { getRepoInfo } from './git.ts'

describe('agent-client', () => {
  it('listSessions returns sessions from at least 2 different projects', async () => {
    const agent = await connectAgent({ client: 'opencode' })
    try {
      const sessions = await agent.listSessions()

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
      agent.kill()
    }
  }, 30_000)

  it('debug: show which sessions would pass sync filters', async () => {
    const connectedAt = '2026-03-21T23:03:40.127Z'
    const connectedAtMs = new Date(connectedAt).getTime()

    console.log(`connectedAt: ${connectedAt} (${connectedAtMs})`)
    console.log(`now:         ${new Date().toISOString()} (${Date.now()})`)
    console.log()

    const agent = await connectAgent({ client: 'opencode' })
    try {
      const sessions = await agent.listSessions()

      // Sort by updatedAt descending (most recent first)
      const sorted = [...sessions].sort((a, b) => {
        const aMs = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
        const bMs = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
        return bMs - aMs
      })

      // Show the 10 most recent sessions with all their timestamps and filter results
      console.log('=== 10 most recent sessions ===')
      for (const session of sorted.slice(0, 10)) {
        const updatedAt = session.updatedAt || '(none)'
        const updatedAtMs = session.updatedAt ? new Date(session.updatedAt).getTime() : 0
        const passesTimeFilter = updatedAtMs >= connectedAtMs
        const hasCwd = !!session.cwd
        const repo = hasCwd ? await getRepoInfo({ cwd: session.cwd! }) : undefined

        console.log(`  session: ${session.sessionId.slice(0, 12)}`)
        console.log(`    title:     ${(session.title || '(none)').slice(0, 80)}`)
        console.log(`    cwd:       ${session.cwd || '(none)'}`)
        console.log(`    updatedAt: ${updatedAt}`)
        console.log(`    passTime:  ${passesTimeFilter}`)
        console.log(`    repo:      ${repo ? repo.slug : '(no repo)'}`)
        console.log()
      }

      // Summary: how many pass each filter
      let noCwd = 0
      let tooOld = 0
      let noRepo = 0
      let wouldSync = 0

      for (const session of sessions) {
        if (!session.cwd) { noCwd++; continue }
        const updatedAtMs = session.updatedAt ? new Date(session.updatedAt).getTime() : 0
        if (updatedAtMs < connectedAtMs) { tooOld++; continue }
        const repo = await getRepoInfo({ cwd: session.cwd })
        if (!repo) { noRepo++; continue }
        wouldSync++
      }

      console.log('=== Summary ===')
      console.log(`  Total sessions:    ${sessions.length}`)
      console.log(`  No cwd:            ${noCwd}`)
      console.log(`  Too old:           ${tooOld}`)
      console.log(`  No git repo:       ${noRepo}`)
      console.log(`  Would sync:        ${wouldSync}`)

      expect(sessions.length).toBeGreaterThan(0)
    } finally {
      agent.kill()
    }
  }, 120_000)
})
