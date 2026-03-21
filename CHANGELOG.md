# openplexer

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
