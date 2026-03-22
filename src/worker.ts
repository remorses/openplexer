// Cloudflare Worker entrypoint for openplexer.
// Handles Notion OAuth flow, persists accounts in UserStore DO,
// and exposes API routes for the CLI to save boards.
// Uses errore pattern: return errors as values, no try-catch for control flow.

import * as errore from 'errore'
import * as z from 'zod'
import { Spiceflow } from 'spiceflow'
import { Client, APIResponseError } from '@notionhq/client'
import type { Env } from './env.ts'

export { UserStore } from './user-store.ts'

class NotionTokenError extends errore.createTaggedError({
  name: 'NotionTokenError',
  message: 'Notion token exchange failed for $operation',
}) {}

class StoreError extends errore.createTaggedError({
  name: 'StoreError',
  message: 'UserStore operation failed for $operation',
}) {}

/** Get the single UserStore DO stub (idFromName("admin")). */
function getUserStore(env: Env) {
  const id = env.USER_STORE.idFromName('admin')
  return env.USER_STORE.get(id)
}

const REDIRECT_PATH = '/auth/callback'

const app = new Spiceflow()
  .state('env', {} as Env)

  .onError(({ error }) => {
    console.error(error)
    const message = error instanceof Error ? error.message : String(error)
    return new Response(message, { status: 500 })
  })

  .route({
    method: 'GET',
    path: '/',
    handler() {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://github.com/remorses/openplexer' },
      })
    },
  })

  .route({
    method: 'GET',
    path: '/health',
    handler() {
      return { status: 'ok' }
    },
  })

  // Step 1: CLI opens browser to this URL. We redirect to Notion OAuth.
  // The CLI passes a random `state` param to correlate the callback.
  .route({
    method: 'GET',
    path: '/auth/notion',
    handler({ request, state }) {
      const url = new URL(request.url)
      const stateParam = url.searchParams.get('state')
      if (!stateParam) {
        return new Response('Missing state parameter', { status: 400 })
      }

      const env = state.env
      const notionAuthUrl = new URL('https://api.notion.com/v1/oauth/authorize')
      notionAuthUrl.searchParams.set('client_id', env.NOTION_CLIENT_ID)
      notionAuthUrl.searchParams.set('response_type', 'code')
      notionAuthUrl.searchParams.set('owner', 'user')
      notionAuthUrl.searchParams.set(
        'redirect_uri',
        new URL(REDIRECT_PATH, url.origin).toString(),
      )
      notionAuthUrl.searchParams.set('state', stateParam)

      return new Response(null, {
        status: 302,
        headers: { Location: notionAuthUrl.toString() },
      })
    },
  })

  // Step 2: Notion redirects here after user authorizes.
  // We exchange the code for tokens and store in KV.
  .route({
    method: 'GET',
    path: REDIRECT_PATH,
    async handler({ request, state }) {
      const url = new URL(request.url)
      const code = url.searchParams.get('code')
      const stateParam = url.searchParams.get('state')

      if (!code || !stateParam) {
        return new Response('Missing code or state parameter', { status: 400 })
      }

      const env = state.env
      const redirectUri = new URL(REDIRECT_PATH, url.origin).toString()

      // Exchange code for tokens via Notion SDK
      const tokenData = await new Client()
        .oauth.token({
          client_id: env.NOTION_CLIENT_ID,
          client_secret: env.NOTION_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        })
        .catch((e: unknown) => new NotionTokenError({ operation: 'exchange', cause: e }))
      if (tokenData instanceof Error) {
        const apiErr = errore.findCause(tokenData, APIResponseError)
        const status = apiErr?.status ?? 500
        console.error('Notion token exchange failed:', tokenData.message)
        return new Response(`Notion authorization failed: ${tokenData.message}`, { status })
      }

      if (!tokenData.refresh_token) {
        return new Response('Notion did not return a refresh token', { status: 502 })
      }

      // Build Notion page URL from duplicated template ID (if present)
      const duplicatedTemplateId = tokenData.duplicated_template_id ?? null
      const notionPageUrl = duplicatedTemplateId
        ? `https://notion.so/${duplicatedTemplateId.replace(/-/g, '')}`
        : null

      // Extract user info from owner
      const ownerUser = tokenData.owner.type === 'user' ? tokenData.owner.user : undefined
      const notionUserName = ownerUser && 'name' in ownerUser ? ownerUser.name : undefined

      // Persist account in the Durable Object first — if this fails, we don't
      // write to KV so the CLI won't see a false-success auth status.
      const store = getUserStore(env)
      const upsertResult = await store.upsertAccount({
        notionUserId: ownerUser?.id ?? tokenData.bot_id,
        notionUserName: String(notionUserName ?? '') || null,
        workspaceId: tokenData.workspace_id,
        workspaceName: String(tokenData.workspace_name ?? '') || null,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
      }).catch((e: unknown) => new StoreError({ operation: 'upsert account', cause: e }))
      if (upsertResult instanceof Error) {
        console.error('Failed to persist account in DO:', upsertResult.message)
        return new Response('Authorization succeeded but account persistence failed. Please retry.', { status: 500 })
      }

      // Store tokens in KV with 5 minute TTL (for CLI polling)
      const kvPayload = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        botId: tokenData.bot_id,
        workspaceId: tokenData.workspace_id,
        workspaceName: tokenData.workspace_name,
        notionUserId: ownerUser?.id,
        notionUserName,
        duplicatedTemplateId,
      }

      await env.OPENPLEXER_KV.put(`auth:${stateParam}`, JSON.stringify(kvPayload), {
        expirationTtl: 300,
      })

      // Show success page with link to the created Notion page (if template was used)
      const pageLink = notionPageUrl
        ? `<a class="button" href="${notionPageUrl}" target="_blank" rel="noopener">Open in Notion <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h7v7M13 3L5 11"/></svg></a>`
        : ''
      const subtitle = notionPageUrl
        ? 'Your board page has been created. You can close this tab and return to the CLI.'
        : 'You can close this tab and return to the CLI.'

      return new Response(
        `<!DOCTYPE html>
<html>
<head>
<title>openplexer - Connected</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #fff;
    --fg: #000;
    --muted: #666;
    --border: #eaeaea;
    --link: #000;
    --link-hover: #666;
    --checkmark-bg: #000;
    --checkmark-fg: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000;
      --fg: #fff;
      --muted: #888;
      --border: #333;
      --link: #fff;
      --link-hover: #999;
      --checkmark-bg: #fff;
      --checkmark-fg: #000;
    }
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh; background: var(--bg); color: var(--fg);
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  }
  .container { text-align: center; padding: 32px; max-width: 380px; }
  .checkmark {
    width: 48px; height: 48px; border-radius: 50%;
    background: var(--checkmark-bg); color: var(--checkmark-fg);
    display: inline-flex; align-items: center; justify-content: center;
    margin-bottom: 24px; font-size: 20px;
  }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; }
  p { font-size: 14px; color: var(--muted); line-height: 1.5; margin-bottom: 24px; }
  a.button {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 500;
    color: var(--link); text-decoration: none;
    border: 1px solid var(--border); transition: color 0.15s;
  }
  a.button:hover { color: var(--link-hover); }
  a.button svg { width: 16px; height: 16px; }
</style>
</head>
<body>
  <div class="container">
    <div class="checkmark">&#10003;</div>
    <h1>Connected to Notion</h1>
    <p>${subtitle}</p>
    ${pageLink}
  </div>
</body>
</html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      )
    },
  })

  // Step 3: CLI polls this endpoint to get the tokens.
  .route({
    method: 'GET',
    path: '/auth/status',
    async handler({ request, state }) {
      const url = new URL(request.url)
      const stateParam = url.searchParams.get('state')
      if (!stateParam) {
        return new Response('Missing state parameter', { status: 400 })
      }

      const result = await state.env.OPENPLEXER_KV.get(`auth:${stateParam}`)
      if (!result) {
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(result, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  // Step 4: CLI calls this to refresh an expired access token.
  // Keeps NOTION_CLIENT_ID / NOTION_CLIENT_SECRET server-side.
  .route({
    method: 'POST',
    path: '/auth/refresh',
    request: z.object({
      refreshToken: z.string().min(1),
    }),
    response: z.object({
      accessToken: z.string(),
      refreshToken: z.string(),
    }),
    async handler({ request, state }) {
      const body = await request.json()

      const env = state.env
      const tokenData = await new Client()
        .oauth.token({
          client_id: env.NOTION_CLIENT_ID,
          client_secret: env.NOTION_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: body.refreshToken,
        })
        .catch((e: unknown) => new NotionTokenError({ operation: 'refresh', cause: e }))
      if (tokenData instanceof Error) {
        const apiErr = errore.findCause(tokenData, APIResponseError)
        const status = apiErr?.status ?? 500
        console.error('Notion token refresh failed:', tokenData.message)
        throw new Response(`Token refresh failed: ${tokenData.message}`, { status })
      }

      if (!tokenData.refresh_token) {
        throw new Response('Notion did not return a refresh token', { status: 502 })
      }

      // Update stored tokens in the DO so they stay current
      const store = getUserStore(env)
      const account = await store
        .getAccountByRefreshToken(body.refreshToken)
        .catch((e: unknown) => new StoreError({ operation: 'get account', cause: e }))
      if (account instanceof Error) {
        console.warn('Failed to look up account in DO:', account.message)
      } else if (account) {
        const updateResult = await store.upsertAccount({
          notionUserId: account.notionUserId,
          notionUserName: account.notionUserName,
          workspaceId: account.workspaceId,
          workspaceName: account.workspaceName,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
        }).catch((e: unknown) => new StoreError({ operation: 'update tokens', cause: e }))
        if (updateResult instanceof Error) {
          console.warn('Failed to update tokens in DO:', updateResult.message)
        }
      }

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
      }
    },
  })

  // --- API routes (authenticated via refresh token) ---

  // Save a board — called by CLI after creating a Notion database
  .route({
    method: 'POST',
    path: '/api/boards',
    request: z.object({
      notionDatabaseId: z.string().min(1),
      notionPageId: z.string().min(1),
      trackedRepos: z.array(z.string()).default([]),
      connectedAt: z.string().default(() => new Date().toISOString()),
    }),
    response: z.object({
      boardId: z.string(),
    }),
    async handler({ request, state }) {
      const env = state.env
      const authHeader = request.headers.get('Authorization') ?? ''
      if (!authHeader.startsWith('Bearer ')) {
        throw new Response('Missing or malformed Authorization header', { status: 401 })
      }
      const refreshToken = authHeader.slice('Bearer '.length)
      if (!refreshToken) {
        throw new Response('Empty Bearer token', { status: 401 })
      }

      const store = getUserStore(env)
      const account = await store
        .getAccountByRefreshToken(refreshToken)
        .catch((e: unknown) => new StoreError({ operation: 'auth lookup', cause: e }))
      if (account instanceof Error) {
        console.error('Auth lookup failed:', account.message)
        throw new Response('Internal error', { status: 500 })
      }
      if (!account) {
        throw new Response('Invalid token', { status: 401 })
      }

      const body = await request.json()

      const boardId = await store
        .saveBoard(account.id, body)
        .catch((e: unknown) => new StoreError({ operation: 'save board', cause: e }))
      if (boardId instanceof Error) {
        console.error('Failed to save board:', boardId.message)
        throw new Response('Failed to save board', { status: 500 })
      }

      return { boardId }
    },
  })

export type App = typeof app

export default {
  fetch(request: Request, env: Env) {
    return app.handle(request, { state: { env } })
  },
}
