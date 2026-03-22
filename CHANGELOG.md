# openplexer

## 0.2.0

1. **Fixed session syncing for opencode** — sessions now sync from all projects, not just one. Previously opencode's ACP protocol scoped sessions to a single project directory, returning ~85 stale sessions. Now openplexer spawns `opencode serve` and uses the `/experimental/session` endpoint with the `@opencode-ai/sdk` v2 client to list all sessions globally.

2. **Board is now embedded inline and defaults to Board (kanban) view** — the Notion database is created with `is_inline: true` so it appears directly in the page instead of as a subpage in the sidebar. The default Table view is replaced with a Board view grouped by Status.

3. **Board is pre-seeded with an example card** — after onboarding, a "Sessions will appear here automatically" card appears in the In Progress column explaining what each property means (Status, Repo, Branch, Resume, Discord, Assignee). Archive it once real sessions start syncing.

4. **Notion page link shown in browser and CLI after onboarding** — the OAuth success page shows an "Open in Notion" button linking directly to your board. The CLI also prints the Notion URL after setup completes.

5. **Board status columns trimmed to 3** — Not Started (for your own todos), In Progress (where synced sessions land), Done.

6. **Sync logging improved** — when a session is added, the CLI prints the title, repo, and a clickable Notion URL. Errors are caught per-session so one failure doesn't abort the entire sync tick.

## 0.1.0

1. **Sync ACP coding sessions to Notion board databases** — openplexer runs as a background daemon on your machine and automatically tracks sessions from OpenCode and/or Claude Code in a Notion kanban board:

   ```
   openplexer        # first run: interactive setup wizard
   openplexer        # subsequent runs: start sync daemon
   ```

   Each session becomes a Notion page with: title, status (In Progress / Done / Needs Attention), git repo, branch link, local folder, resume command, and Discord thread link (if kimaki is installed).

2. **Interactive setup wizard** — on first run, walks through agent selection, repo filtering, Notion OAuth, and board creation in a single flow using clack prompts. A Board view is automatically created in Notion grouped by Status.

3. **Multi-agent support** — select one or both of OpenCode and Claude Code. Sessions from both are merged into a single board, tagged with their source so the correct resume command is generated:

   ```
   opencode --session <id>   # for OpenCode sessions
   claude --resume <id>      # for Claude Code sessions
   ```

4. **Multiple boards** — connect multiple Notion pages, each with its own repo filter and assignee. Add more boards at any time:

   ```bash
   openplexer connect
   ```

5. **Repo filtering** — choose which git repos to track. Select specific repos for shared collaborative boards, or `* All repos` to track everything:

   ```
   ◆  Which repos to track?
   │  ◼ * All repos
   │  ◻ remorses/kimaki
   ```

6. **Startup registration** — register openplexer to run automatically on login (launchd on macOS, XDG autostart on Linux, registry on Windows):

   ```bash
   openplexer startup enable
   openplexer startup disable
   openplexer startup          # show registration status
   ```

7. **Single-instance enforcement** — only one sync daemon runs at a time. Starting a new instance kills the existing one cleanly.

8. **Notion OAuth proxy** — authentication is handled via openplexer.com (Cloudflare Worker). No manual token setup needed — just authorize in the browser and the CLI picks up the token automatically.
