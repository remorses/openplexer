# openplexer

Track every coding session across your team in a Notion board. Automatically.

```
npm install -g openplexer
```

## The problem

AI coding agents are everywhere now. OpenCode, Claude Code, Codex — you run them in worktrees, in different repos, on different branches. You start a session to fix a bug, another to refactor auth, another to explore an idea. Some finish, some don't. Some need your attention, some are fine.

After a week you have 40+ sessions scattered across your machine with no way to tell which ones matter.

**For solo developers**, it's hard to keep track. You forget about sessions. You don't know which worktree has unfinished work. You resume the wrong one. You lose context.

**For teams**, it's worse. You have no idea what your teammates are working on right now. You can't see if someone already started a session on the bug you're about to fix. There's no shared view of who's doing what, on which branch, in which repo. No way to flag a session as "needs review" or "blocked" or "done — merge it."

## The solution

openplexer runs as a background daemon on your machine. It connects to your coding agents via ACP (Agent Client Protocol), discovers all your sessions, and syncs them to a Notion kanban board — automatically, every 5 seconds.

```
┌──────────────┐                     ┌────────────────────────┐
│  OpenCode    │◄── ACP (stdio) ────►│                        │
│  Claude Code │◄── ACP (stdio) ────►│      openplexer        │
│  Codex       │◄── ACP (stdio) ────►│      (background)      │
└──────────────┘                     │                        │
                                     │  syncs every 5 seconds │
                                     └───────────┬────────────┘
                                                 │
                                                 │ Notion API
                                                 ▼
                                     ┌────────────────────────┐
                                     │      Notion Board      │
                                     │     (shared kanban)    │
                                     └────────────────────────┘
```

Each session becomes a card on the board. You can see at a glance:

- **What's in progress** — sessions that are still running or were never finished
- **What's done** — completed sessions you can archive or review
- **What needs attention** — sessions you manually flag for follow-up
- **Who's working on what** — every card is assigned to the person who started it
- **Which repo and branch** — direct links to the GitHub branch
- **How to resume** — a ready-to-paste CLI command to pick up where you left off

## Collaborative by default

The board is a shared Notion page. Multiple team members can connect their machines to the same board. Each person's sessions show up automatically, assigned to them.

This means your team gets a single view of all active coding work:

- Alice is refactoring the auth module on `feature/auth-v2` in `acme/backend` — **In Progress**
- Bob finished the migration script on `fix/db-migrate` in `acme/infra` — **Done**
- Charlie's session on `acme/frontend` needs review — **Needs Attention**

No standups needed to know what's happening. No Slack messages asking "are you still working on that?" The board is always current because every machine syncs continuously.

Each user controls which repos they sync to the shared board. If you're also hacking on personal side projects, those sessions stay off the shared board — only repos you explicitly select are tracked. This keeps the shared view clean and focused on team work.

## Getting started

Run `openplexer` for the first time and the setup wizard walks you through everything:

**1. Pick your agents**

```
◆  Which coding agents do you use?
│  ◼ OpenCode
│  ◼ Claude Code
│  ◻ Codex
```

Select one or more. openplexer connects to each via ACP and merges all sessions into a single board.

**2. Auto-discover repos**

openplexer spawns the ACP server, lists all your sessions, and extracts the git repos from their working directories. No manual configuration needed.

**3. Select repos to track**

```
◆  Which repos to track?
│  ◼ * All repos
│  ◻ acme/backend
│  ◻ acme/frontend
│  ◻ acme/infra
```

Pick specific repos for shared boards (recommended — keeps personal projects off the team board). Or select all if you want everything tracked.

**4. Connect Notion**

Your browser opens to authorize the Notion integration. Select the page where the board should live. No manual API tokens, no copying secrets — just click authorize and you're done.

**5. Board created**

openplexer creates a database inside your selected Notion page with a kanban Board view grouped by status. An example card explains what each field means. Real sessions start appearing within seconds.

**6. Run on login (optional)**

```
◆  Register openplexer to run on login?
│  Yes
```

openplexer registers itself as a startup service so it runs in the background every time you log in. The board stays current without you having to think about it.

## Board properties

Every session card in Notion has these fields:

| Property | Type | Description |
|---|---|---|
| **Name** | Title | Session title from the agent |
| **Status** | Select | `In Progress`, `Done`, `Needs Attention`, `Ignored`, `Not Started` |
| **Activity** | Select | `Running` (agent generating), `Idle` (waiting for user). OpenCode only |
| **Repo** | Select | GitHub repo as `owner/repo` |
| **Branch** | Text | Link to the branch on GitHub |
| **Model** | Text | AI model used (e.g. `claude-sonnet-4-20250514`) |
| **Share URL** | URL | Public share link (OpenCode `/share`) |
| **Resume** | Text | CLI command to resume the session |
| **Assignee** | People | Notion user who authorized the integration |
| **Folder** | Text | Local filesystem path |
| **Kimaki** | URL | Discord thread link (if using kimaki). OpenCode only |
| **Created** | Date | When the session was first synced |
| **Updated** | Date | Last update timestamp from the agent |
| **Session ID** | Text | Internal ACP session identifier |

**Status** is the only field you manage manually. Everything else is synced automatically. Move cards between columns as you triage — mark sessions as done when you're finished, flag ones that need attention, ignore ones you don't care about.

### Silencing assignee notifications

By default, Notion sends you a notification every time openplexer creates a new session card because it sets you as the Assignee. The Notion API doesn't support suppressing these notifications, but you can disable them in the Notion UI:

1. Open your openplexer board in Notion
2. Click the **Assignee** property header (or any card's Assignee field, then the gear icon)
3. Under **Notify**, select **None**

This stops all notifications from the Assignee property while keeping the assignment visible on cards.

**Resume** gives you the exact command to pick up a session:

```bash
# OpenCode sessions
opencode --session ses_abc123

# Claude Code sessions
claude --resume ses_abc123

# Codex sessions
codex resume ses_abc123
```

## CLI commands

```bash
openplexer              # Start daemon (first run triggers setup wizard)
openplexer connect      # Add another board
openplexer status       # Show sync state and session counts
openplexer boards       # List all configured boards with URLs
openplexer stop         # Kill the running daemon
openplexer startup      # Show startup registration status
openplexer startup enable   # Register to run on login
openplexer startup disable  # Unregister from login
```

## Multiple boards

You can connect as many boards as you want. Each board is a separate Notion database with its own repo filter and assignee.

```bash
openplexer connect
```

Use cases:
- **Team board** — shared page, filtered to company repos, everyone connects to it
- **Personal board** — private page, all repos, just for you
- **Project board** — scoped to a single repo for focused tracking

## How it works

**ACP protocol** — openplexer spawns each agent's ACP server as a child process and communicates over stdio using the Agent Client Protocol. It lists all sessions with pagination and extracts git repo info from each session's working directory.

**Sync loop** — every 5 seconds, openplexer polls all connected agents for sessions. New sessions get a Notion page created. Existing sessions get their title and timestamp updated. Only sessions created or updated after the board was connected are synced (no backfilling old sessions).

**Single instance** — a lock port (default `29990`) ensures only one daemon runs at a time. Starting a new instance cleanly terminates the old one via SIGTERM, then SIGKILL if needed.

**Notion OAuth** — authentication goes through `openplexer.com` (a Cloudflare Worker). The CLI opens your browser, you authorize, the worker exchanges the code for tokens and stores them in KV with a 5-minute TTL. The CLI polls for the result. No secrets to manage.

**Startup service** — cross-platform registration so openplexer starts automatically:
- **macOS**: launchd plist at `~/Library/LaunchAgents/com.openplexer.plist`
- **Linux**: XDG autostart at `~/.config/autostart/openplexer.desktop`
- **Windows**: registry key at `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

**Config** — stored at `~/.openplexer/config.json`. Contains the list of agents, board configurations (Notion tokens, database IDs, tracked repos), and a map of synced session IDs to Notion page IDs.

**Rate limiting** — Notion API calls are throttled to ~3/second to stay within rate limits.

## Discord integration

If you use [kimaki](https://kimaki.xyz) to run coding sessions from Discord, openplexer automatically detects the kimaki CLI and adds a Discord thread URL to each session card. This links the Notion board directly to the Discord conversation where the work is happening.

## License

MIT
