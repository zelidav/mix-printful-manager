# Made in Xiaolin — Printful Manager (MiX)

Multi-store Printful product/price/description manager. **Each store is a separate Printful
account with its own PAT** (Personal Access Token); a **Store picker** in the header chooses
which one every action routes through.

Split off from the Jerome Baker manager (`~/printful-manager`) — that one stays the JB path,
this is the MiX path. They share no tokens or stores.

## Run

```bash
npm install        # (node_modules already vendored)
node server.js     # http://localhost:3600
```

Sign in with `APP_PASSWORD` (see `.env`).

## Configure stores

Each store needs its own PAT. To add one:

1. Create the Printful PAT for that store/account.
2. Add it to `.env`:  `PAT_<SLUG>=<token>`
3. Append an entry in `accounts.js`:

```js
{ id: 'slug', name: 'Made in Xiaolin - <Store>', token: process.env.PAT_SLUG },
```

The picker, store resolution, and per-PAT routing pick it up automatically.

## Env (`.env`, gitignored)

| Key | Purpose |
|-----|---------|
| `PORT` | server port (default 3600) |
| `APP_PASSWORD` | admin sign-in password |
| `PAT_DAVES` | PAT for "Made in Xiaolin - Daves Dispensary" |

## How it routes

- `GET /api/accounts` → the configured stores (names only, never tokens)
- `X-PF-Account: <id>` header (sent by the UI) selects the store → its PAT is used for every
  Printful call. `GET /api/stores` returns that PAT's live Printful store(s); a single store
  auto-selects.
- Saves/price/description updates go through the Printful API (native stores).
