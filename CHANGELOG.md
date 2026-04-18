# openplexer

## 0.3.0

1. **New Activity property** — session cards now show real-time activity status. A blue **Running** pill means the agent is actively generating; yellow **Idle** means it's waiting for user input. Polls opencode's bulk status endpoint every sync tick:

   ```
   Activity: Running  (blue)
   Activity: Idle     (yellow)
   ```

   OpenCode sessions only — Claude Code and Codex don't expose activity data.

2. **First user prompt & model on session pages** — each session page now displays the initial prompt that started the conversation, plus the AI model being used:

   - **Prompt** — written as a rich text property on the Notion page (write-once, so your own notes won't be overwritten)
   - **Model** — a new text property showing the model ID (e.g. `claude-sonnet-4-20250514`)

   OpenCode sessions only.

3. **Auto-share sessions with public URLs** — openplexer automatically creates a public share link for each session using opencode's `/share` endpoint. The **Share URL** property appears on every card as a clickable link:

   ```bash
   # The share link is generated automatically — no action needed
   # Click the Share URL property on any card to open it
   ```

   OpenCode sessions only.

4. **New `--assignee` flag** — opt-in to assign Notion users to session cards. Disabled by default because Notion sends a notification per assignment and the API can't suppress them:

   ```bash
   openplexer --assignee    # enable assignee property on cards
   ```

   If enabled, manually silence notifications: open the board → click Assignee property header → set Notify to None.

5. **GitHub PR URL detection** — session cards now show a **PR** property with a direct link to the open pull request for the session's branch. Automatically detects PRs using the `gh` CLI and retries for 10 minutes after session start (useful when PRs are opened after the session begins).

6. **Notion native SVG icons** — replaced emoji-based icons with Notion's 158-icon catalog. Icons are deterministically assigned per session using an FNV-1a hash of the session ID. Branch colors are also hash-based, with default branches (main/master) always getting light gray. Icons now render consistently with Notion's UI.

7. **Cleaner board cards** — improved card visibility and information density:

   - **Branch** shows short name with clickable GitHub link (not full URL)
   - **Folder** shows `~/projects/repo` instead of full absolute path
   - **Created** date tracks when openplexer first synced the session
   - Status, Repo, Updated, and Created are now visible on kanban cards by default

8. **Filter out agent sub-sessions** — internal agent tasks (child sessions with a `parentId`) are no longer synced to the board. Only top-level sessions appear, reducing noise.

9. **Skip placeholder titles** — new sessions with auto-generated placeholder titles (like "New session...") are held back for up to 5 minutes while the agent finishes generating the real title. Falls back to syncing after the grace period if title generation fails.

10. **Notion OAuth token refresh** — refresh tokens are now automatically exchanged when expired. Sessions stay synced without re-authenticating. Worker stores accounts in a Durable Object with SQLite persistence.

11. **Durable Object backend** — user accounts and board configurations are persisted in a Cloudflare Durable Object running SQLite with Drizzle ORM. The database is exposed via `libsql://libsqlproxy.openplexer.com` for admin access:

    ```bash
    pnpm libsql    # prints connection URL with auth token
    ```

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
