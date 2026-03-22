// Deterministic emoji assignment for repos.
// Hashes owner/repo slug to pick a visually distinct emoji from a curated list.
// Users can override per-repo via config.repoIcons.

// Curated list of visually distinct emojis — no flags, no skin tones,
// no duplicates, no obscure symbols. Each one is easy to distinguish
// at small sizes in Notion's kanban board UI.
const REPO_EMOJIS = [
  '🔵', '🟢', '🟡', '🟠', '🔴', '🟣', '⚫', '🟤',
  '💎', '🔮', '🧊', '🪐', '🌊', '🌋', '🌸', '🍀',
  '🔥', '⚡', '💧', '🌙', '☀️', '⭐', '🌈', '❄️',
  '🎯', '🎲', '🎨', '🎭', '🎪', '🎬', '🎸', '🎺',
  '🚀', '🛸', '⛵', '🏔️', '🏝️', '🗻', '🌵', '🍄',
  '🐙', '🦊', '🐝', '🦋', '🐬', '🦅', '🐺', '🦉',
  '🧪', '🔬', '🔭', '💡', '🔧', '⚙️', '🛡️', '🗝️',
  '📦', '🧩', '🎁', '🏷️', '📌', '🔖', '🧲', '💠',
] as const

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
 * by small numbers (like 64) doesn't rely only on the weak low bits.
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
 * Get a deterministic emoji for a repo slug (e.g. "owner/repo").
 * Same slug always returns the same emoji.
 */
export function getRepoEmoji(slug: string): string {
  const index = mix32(fnv1a(slug)) % REPO_EMOJIS.length
  return REPO_EMOJIS[index]
}

/**
 * Resolve the icon for a repo: user override takes priority, then hash-based.
 * When branch is provided, it's included in the hash so different branches
 * on the same repo get different emojis.
 */
export function resolveRepoIcon({
  slug,
  branch,
  repoIcons,
}: {
  slug: string
  branch?: string
  repoIcons?: Record<string, string>
}): string {
  if (repoIcons?.[slug]) {
    return repoIcons[slug]
  }
  const hashKey = branch ? `${slug}:${branch}` : slug
  return getRepoEmoji(hashKey)
}
