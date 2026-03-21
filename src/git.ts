// Extract git repo info from session cwd paths.
// Parses the remote origin URL to get owner/repo.

import { execFile } from 'node:child_process'

export type RepoInfo = {
  owner: string
  repo: string
  /** e.g. "owner/repo" */
  slug: string
  /** Full GitHub URL */
  url: string
  /** Current branch name */
  branch: string
}

export async function getRepoInfo({ cwd }: { cwd: string }): Promise<RepoInfo | undefined> {
  const remoteUrl = await execAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin']).catch(
    () => {
      return undefined
    },
  )
  if (!remoteUrl) {
    return undefined
  }

  const parsed = parseGitRemoteUrl(remoteUrl.trim())
  if (!parsed) {
    return undefined
  }

  const branch = await execAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(
    () => {
      return 'main'
    },
  )

  return {
    ...parsed,
    branch: branch.trim(),
  }
}

function parseGitRemoteUrl(url: string): { owner: string; repo: string; slug: string; url: string } | undefined {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+)/)
  if (sshMatch) {
    const owner = sshMatch[1]
    const repo = sshMatch[2]
    return {
      owner,
      repo,
      slug: `${owner}/${repo}`,
      url: `https://github.com/${owner}/${repo}`,
    }
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/)
  if (httpsMatch) {
    const owner = httpsMatch[1]
    const repo = httpsMatch[2]
    return {
      owner,
      repo,
      slug: `${owner}/${repo}`,
      url: `https://github.com/${owner}/${repo}`,
    }
  }

  return undefined
}

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}
