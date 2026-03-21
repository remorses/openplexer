// Cloudflare Worker entrypoint for openplexer.
// Handles Notion OAuth flow: redirects user to Notion, receives callback
// with auth code, exchanges it for tokens, and stores result in KV for
// the CLI to poll. Same pattern as kimaki's gateway onboarding.

import { Spiceflow } from 'spiceflow'
import type { Env } from './env.ts'

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

      // Exchange code for tokens
      const encoded = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`)
      const tokenResponse = await fetch('https://api.notion.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Basic ${encoded}`,
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      })

      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text()
        console.error('Notion token exchange failed:', errorBody)
        return new Response(`Notion authorization failed: ${errorBody}`, { status: 500 })
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string
        token_type: string
        bot_id: string
        workspace_id: string
        workspace_name: string
        owner: { type: string; user?: { id: string; name: string } }
      }

      // Store tokens in KV with 5 minute TTL
      const kvPayload = {
        accessToken: tokenData.access_token,
        botId: tokenData.bot_id,
        workspaceId: tokenData.workspace_id,
        workspaceName: tokenData.workspace_name,
        notionUserId: tokenData.owner?.user?.id,
        notionUserName: tokenData.owner?.user?.name,
      }

      await env.OPENPLEXER_KV.put(`auth:${stateParam}`, JSON.stringify(kvPayload), {
        expirationTtl: 300,
      })

      // Show success page
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>openplexer - Connected</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center;
         align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
  .card { text-align: center; padding: 48px; border-radius: 12px;
          background: #16213e; max-width: 400px; }
  h1 { margin: 0 0 16px; font-size: 24px; }
  p { color: #999; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connected to Notion</h1>
    <p>You can close this tab and return to the CLI.</p>
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

export default {
  fetch(request: Request, env: Env) {
    return app.handle(request, { state: { env } })
  },
}
