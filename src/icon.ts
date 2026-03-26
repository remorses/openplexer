// Deterministic Notion icon assignment for sessions.
// Hashes session ID to pick an icon slug, hashes branch to pick a color.
// Default branch (main/master) always gets 'lightgray'.
// URL format: https://www.notion.so/icons/{slug}_{color}.svg

import { NOTION_ICON_SLUGS, NOTION_ICON_COLORS } from './notion-icons.ts'

const NOTION_ICONS_BASE_URL = 'https://www.notion.so/icons'

/** Default branch names that get the neutral 'lightgray' color. */
const DEFAULT_BRANCHES = new Set(['main', 'master'])

/** Colors available for non-default branches (everything except lightgray). */
const BRANCH_COLORS = NOTION_ICON_COLORS.filter((c) => c !== 'lightgray')

/**
 * FNV-1a hash (32-bit). Fast, good distribution for short strings.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Final avalanche mix — spreads entropy across all 32 bits so modulo
 * by small numbers doesn't rely only on the weak low bits.
 */
function mix32(x: number): number {
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

/**
 * Get a deterministic Notion icon slug for a session ID.
 */
export function getIconSlug(sessionId: string): string {
  const index = mix32(fnv1a(sessionId)) % NOTION_ICON_SLUGS.length
  return NOTION_ICON_SLUGS[index]
}

/**
 * Get a deterministic color for a branch name.
 * Default branches (main/master) get 'lightgray'.
 * Other branches get one of 9 non-neutral colors via hash.
 */
export function getBranchColor(branch: string, defaultBranch?: string): string {
  if (DEFAULT_BRANCHES.has(branch) || branch === defaultBranch) {
    return 'lightgray'
  }
  const index = mix32(fnv1a(branch)) % BRANCH_COLORS.length
  return BRANCH_COLORS[index]
}

/**
 * Build a Notion icon URL from slug + color.
 */
export function buildIconUrl(slug: string, color: string): string {
  return `${NOTION_ICONS_BASE_URL}/${slug}_${color}.svg`
}

/**
 * Resolve the full Notion icon URL for a session.
 * - Icon shape is determined by hashing the session ID.
 * - Color is determined by hashing the branch name.
 * - Default branches (main/master) get neutral 'lightgray'.
 */
export function resolveSessionIcon({
  sessionId,
  branch,
  defaultBranch,
}: {
  sessionId: string
  branch?: string
  defaultBranch?: string
}): string {
  const slug = getIconSlug(sessionId)
  const color = getBranchColor(branch ?? 'main', defaultBranch)
  return buildIconUrl(slug, color)
}
