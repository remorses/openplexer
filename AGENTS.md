use pnpm

to read notion sdk and api documentation fetch https://developers.notion.com/llms.txt

## error handling

This repo uses the errore pattern (errors as values, not exceptions). ALWAYS load the `errore` skill before adding or modifying code. Key rules:

- `import * as errore from 'errore'` — namespace import, never destructure
- Never throw for expected failures — return errors as values
- Use `.catch((e) => new MyTaggedError({ cause: e }))` at async boundaries, `errore.try` at sync boundaries
- Use `createTaggedError` for domain errors
- Use `instanceof Error` checks with early returns — keep happy path at root indentation
- No `let` + `try-catch` — use `const` + `.catch()` expressions
- Always log errors that are not propagated (swallowed errors must leave a trace)

## drizzle orm

This repo uses drizzle-orm v1 beta with Relational Queries v2 (object-style where).

Always use namespace imports for drizzle-orm to avoid polluting the local scope with generic names like `eq`, `and`, `gt`:

```ts
import * as orm from 'drizzle-orm'
import * as sqliteCore from 'drizzle-orm/sqlite-core'
import * as durable from 'drizzle-orm/durable-sqlite'

// then use orm.eq, orm.and, etc.
```

Relations are defined in `src/db/schema.ts` using `defineRelations` (v2 API). Pass `relations` to `drizzle()`.

Use the Prisma-like `db.query` API with **object-style `where`** for reads:

```ts
// GOOD: object-style where (v2) — no imports needed for operators
db.query.accounts.findFirst({ where: { refreshToken } }).sync()

// For complex filters: use OR, AND, NOT, gt, like, etc.
db.query.accounts.findMany({
  where: { OR: [{ status: 'active' }, { name: { like: 'John%' } }] },
  with: { boards: true },
})
```

Use `db.insert`, `db.update`, `db.delete` for writes (no query API equivalent). Write `.where()` clauses still use `orm.eq()`.

## backward compatibility

This repo is not yet used in production. Do not add backward compatibility code, legacy migration logic, or union types to handle old config formats. Keep types clean and direct.
