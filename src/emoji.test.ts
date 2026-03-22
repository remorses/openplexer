// Tests for deterministic emoji assignment via FNV-1a hash.

import { describe, it, expect } from 'vitest'
import { getRepoEmoji, resolveRepoIcon } from './emoji.ts'

describe('getRepoEmoji', () => {
  it('returns the same emoji for the same slug', () => {
    const emoji1 = getRepoEmoji('remorses/openplexer')
    const emoji2 = getRepoEmoji('remorses/openplexer')
    expect(emoji1).toBe(emoji2)
  })

  it('returns a non-empty string', () => {
    expect(getRepoEmoji('owner/repo')).toBeTruthy()
    expect(getRepoEmoji('owner/repo').length).toBeGreaterThan(0)
  })

  it('different repos get different emojis (spot check)', () => {
    const slugs = [
      'remorses/openplexer',
      'remorses/kimaki',
      'vercel/next.js',
      'facebook/react',
      'denoland/deno',
      'golang/go',
      'rust-lang/rust',
      'microsoft/vscode',
    ]
    const emojis = slugs.map(getRepoEmoji)
    const unique = new Set(emojis)
    // With 8 slugs and 64 emojis, collisions are unlikely but possible.
    // At least 6 out of 8 should be unique.
    expect(unique.size).toBeGreaterThanOrEqual(6)
  })

  it('handles edge cases', () => {
    expect(getRepoEmoji('')).toBeTruthy()
    expect(getRepoEmoji('a')).toBeTruthy()
    expect(getRepoEmoji('a/very/deeply/nested/path/that/is/long')).toBeTruthy()
  })

  it('snapshot a few known mappings for stability', () => {
    expect(getRepoEmoji('remorses/openplexer')).toMatchInlineSnapshot(`"💧"`)
    expect(getRepoEmoji('vercel/next.js')).toMatchInlineSnapshot(`"🟤"`)
    expect(getRepoEmoji('facebook/react')).toMatchInlineSnapshot(`"⚙️"`)
  })
})

describe('resolveRepoIcon', () => {
  it('returns hash-based emoji when no overrides', () => {
    const emoji = resolveRepoIcon({ slug: 'owner/repo' })
    expect(emoji).toBe(getRepoEmoji('owner/repo'))
  })

  it('returns override when present', () => {
    const emoji = resolveRepoIcon({
      slug: 'owner/repo',
      repoIcons: { 'owner/repo': '🚀' },
    })
    expect(emoji).toBe('🚀')
  })

  it('falls back to hash when slug not in overrides', () => {
    const emoji = resolveRepoIcon({
      slug: 'owner/repo',
      repoIcons: { 'other/repo': '🚀' },
    })
    expect(emoji).toBe(getRepoEmoji('owner/repo'))
  })

  it('handles undefined repoIcons', () => {
    const emoji = resolveRepoIcon({ slug: 'owner/repo', repoIcons: undefined })
    expect(emoji).toBe(getRepoEmoji('owner/repo'))
  })
})
