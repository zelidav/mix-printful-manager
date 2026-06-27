# Made in Xiaolin — Printful Manager (MiX)

Multi-store Printful product/price/description manager. **Each store is a separate Printful
account with its own PAT** (Personal Access Token); a **Store picker** routes every action
through the selected store's token.

Split off from the Jerome Baker manager (`~/printful-manager`) — that one stays the JB path,
this is the MiX path. No shared tokens or stores.

## Architecture (same pattern as `jb-printful-creator`)

- **`frontend/`** — static UI, hosted on **GitHub Pages** → https://zelidav.github.io/mix-printful-manager/
- **`backend/`** — Express API on **Cloud Run** (project `printful-manager`, us-east1) →
  https://mix-printful-api-915738985818.us-east1.run.app
- The frontend calls the backend via CORS; PATs live only in the backend's Cloud Run env.

## Add a store (each its own PAT)

1. Create the Printful PAT.
2. Add it to the backend's Cloud Run env: `PAT_<SLUG>=<token>` (and `backend/.env` for local).
3. Append one line to `backend/accounts.js`:
   ```js
   { id: 'slug', name: 'Made in Xiaolin - <Store>', token: process.env.PAT_SLUG },
   ```
4. Redeploy backend.

## Deploy / update

```sh
# backend (Cloud Run)
cd backend && npm run deploy           # set env vars on first deploy / via console

# frontend (GitHub Pages) — just push; the Actions workflow redeploys
git push
```

First backend deploy set: `APP_PASSWORD`, `ALLOWED_ORIGIN=https://zelidav.github.io`, `PAT_DAVES`.

## Local dev

```sh
cd backend && cp .env.example .env   # fill values, then:
npm install && npm run dev           # API on :8080
# open frontend/index.html (point BACKEND const at http://localhost:8080 for local)
```

## Sign in

Open the Pages URL → enter `APP_PASSWORD`. Pick a store → Load Products.
