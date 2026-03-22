// Typed environment variables for the Cloudflare Worker.
// NOTION_CLIENT_ID and NOTION_CLIENT_SECRET are the openplexer Notion
// integration's OAuth2 credentials, used to exchange auth codes for tokens.

import type { UserStore } from './user-store.ts'

export type Env = {
  OPENPLEXER_KV: KVNamespace
  USER_STORE: DurableObjectNamespace<UserStore>
  NOTION_CLIENT_ID: string
  NOTION_CLIENT_SECRET: string
}
