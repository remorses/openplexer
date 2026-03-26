// Tests for deterministic Notion icon assignment via FNV-1a hash.

import { describe, it, expect } from 'vitest'
import { getIconSlug, getBranchColor, buildIconUrl, resolveSessionIcon } from './icon.ts'
import { NOTION_ICON_SLUGS, NOTION_ICON_COLORS } from './notion-icons.ts'

describe('getIconSlug', () => {
  it('returns the same slug for the same session ID', () => {
    const slug1 = getIconSlug('ses_abc123')
    const slug2 = getIconSlug('ses_abc123')
    expect(slug1).toBe(slug2)
  })

  it('returns a valid Notion icon slug', () => {
    const slug = getIconSlug('ses_abc123')
    expect(NOTION_ICON_SLUGS).toContain(slug)
  })

  it('different session IDs get different slugs (spot check)', () => {
    const ids = [
      'ses_abc123',
      'ses_def456',
      'ses_ghi789',
      'ses_jkl012',
      'ses_mno345',
      'ses_pqr678',
      'ses_stu901',
      'ses_vwx234',
    ]
    const slugs = ids.map(getIconSlug)
    const unique = new Set(slugs)
    // With 8 IDs and 158 icons, collisions are very unlikely
    expect(unique.size).toBeGreaterThanOrEqual(6)
  })

  it('handles edge cases', () => {
    expect(NOTION_ICON_SLUGS).toContain(getIconSlug(''))
    expect(NOTION_ICON_SLUGS).toContain(getIconSlug('a'))
    expect(NOTION_ICON_SLUGS).toContain(getIconSlug('a-very-long-session-id-that-goes-on-and-on'))
  })

  it('snapshot known mappings for stability', () => {
    expect(getIconSlug('ses_abc123')).toMatchInlineSnapshot(`"cut"`)
    expect(getIconSlug('ses_opencode_001')).toMatchInlineSnapshot(`"star-outline"`)
  })
})

describe('getBranchColor', () => {
  it('returns lightgray for main', () => {
    expect(getBranchColor('main')).toBe('lightgray')
  })

  it('returns lightgray for master', () => {
    expect(getBranchColor('master')).toBe('lightgray')
  })

  it('returns lightgray for custom default branch', () => {
    expect(getBranchColor('develop', 'develop')).toBe('lightgray')
  })

  it('returns a non-lightgray color for feature branches', () => {
    const color = getBranchColor('feature/auth')
    expect(color).not.toBe('lightgray')
    expect(NOTION_ICON_COLORS).toContain(color)
  })

  it('same branch always gets same color', () => {
    const color1 = getBranchColor('feature/auth')
    const color2 = getBranchColor('feature/auth')
    expect(color1).toBe(color2)
  })

  it('different branches get different colors (spot check)', () => {
    const branches = [
      'feature/auth',
      'feature/icons',
      'fix/bug-123',
      'refactor/sync',
      'chore/deps',
      'release/v2',
    ]
    const colors = branches.map((b) => getBranchColor(b))
    const unique = new Set(colors)
    // With 6 branches and 9 colors, most should be unique
    expect(unique.size).toBeGreaterThanOrEqual(4)
  })

  it('snapshot known mappings for stability', () => {
    expect(getBranchColor('feature/auth')).toMatchInlineSnapshot(`"gray"`)
    expect(getBranchColor('fix/bug-123')).toMatchInlineSnapshot(`"gray"`)
  })
})

describe('buildIconUrl', () => {
  it('builds correct URL format', () => {
    expect(buildIconUrl('code', 'blue')).toBe(
      'https://www.notion.so/icons/code_blue.svg',
    )
  })

  it('handles all colors', () => {
    for (const color of NOTION_ICON_COLORS) {
      const url = buildIconUrl('rocket', color)
      expect(url).toBe(`https://www.notion.so/icons/rocket_${color}.svg`)
    }
  })
})

describe('resolveSessionIcon', () => {
  it('returns a valid Notion icon URL', () => {
    const url = resolveSessionIcon({ sessionId: 'ses_abc123', branch: 'feature/auth' })
    expect(url).toMatch(/^https:\/\/www\.notion\.so\/icons\/[a-z0-9-]+_[a-z]+\.svg$/)
  })

  it('uses lightgray for main branch', () => {
    const url = resolveSessionIcon({ sessionId: 'ses_abc123', branch: 'main' })
    expect(url).toContain('_lightgray.svg')
  })

  it('uses lightgray for master branch', () => {
    const url = resolveSessionIcon({ sessionId: 'ses_abc123', branch: 'master' })
    expect(url).toContain('_lightgray.svg')
  })

  it('uses non-lightgray color for feature branches', () => {
    const url = resolveSessionIcon({ sessionId: 'ses_abc123', branch: 'feature/auth' })
    expect(url).not.toContain('_lightgray.svg')
  })

  it('same session ID gets same icon slug regardless of branch', () => {
    const url1 = resolveSessionIcon({ sessionId: 'ses_abc123', branch: 'main' })
    const url2 = resolveSessionIcon({ sessionId: 'ses_abc123', branch: 'feature/auth' })
    // Extract slug from URL: /icons/{slug}_{color}.svg
    const slug1 = url1.match(/\/icons\/([^_]+)_/)?.[1]
    const slug2 = url2.match(/\/icons\/([^_]+)_/)?.[1]
    expect(slug1).toBe(slug2)
  })

  it('different session IDs get different icon slugs (same branch)', () => {
    const url1 = resolveSessionIcon({ sessionId: 'ses_abc123', branch: 'main' })
    const url2 = resolveSessionIcon({ sessionId: 'ses_xyz789', branch: 'main' })
    const slug1 = url1.match(/\/icons\/([^_]+)_/)?.[1]
    const slug2 = url2.match(/\/icons\/([^_]+)_/)?.[1]
    // Not guaranteed to be different, but with good hashing they should differ
    expect(slug1).not.toBe(slug2)
  })

  it('defaults to lightgray when no branch provided', () => {
    const url = resolveSessionIcon({ sessionId: 'ses_abc123' })
    expect(url).toContain('_lightgray.svg')
  })

  it('uses lightgray for custom default branch', () => {
    const url = resolveSessionIcon({ sessionId: 'ses_abc123', branch: 'develop', defaultBranch: 'develop' })
    expect(url).toContain('_lightgray.svg')
  })
})
