# Putting the database somewhere that is not your laptop

Compass Search keeps two quite different things, and it is worth being clear
about which is which before choosing where they live.

| What | Where it lives | What is lost if the machine goes away |
| --- | --- | --- |
| **The search index** — every product, built for retrieval | Typesense, or the local SQLite file | Nothing. It is rebuilt from the catalogue feed in minutes. |
| **Everything a person decided** — merchandising rules, synonyms, redirects, collections, badges, experiments, API keys, and every shopper event the reports are built from | PostgreSQL | All of it. None of it can be recovered from the feed. |

The index is disposable by design. The Postgres side is not: it is the record
of what your team changed and what your shoppers did, and on a laptop or a
container it disappears the moment that machine does.

So this is the half worth hosting.

## Why Supabase fits

Compass Search needs plain PostgreSQL 16 and nothing else. The migrations use
no extensions, no superuser operations, no `LISTEN`/`NOTIFY` and no
session-scoped state — checked, not assumed — which means a managed Postgres
runs them unmodified, and a pooled connection is safe.

Supabase is Postgres with backups, a dashboard and a connection string. Neon,
RDS or a Postgres container on your own server all work identically; nothing
below is Supabase-specific except the hostnames.

## Setting it up

1. Create a project at supabase.com. Pick a region near your storefront —
   every search that touches merchandising rules pays this round trip once.
2. **Project Settings → Database → Connection string → URI.** Take the
   **Session pooler** string. It looks like:

   ```
   postgresql://postgres.abcdefgh:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```

   The transaction pooler on port 6543 also works — nothing here needs a
   sticky session — but the session pooler leaves you fewer things to think
   about later.
3. Point the app at it and start it. Migrations run on startup:

   ```powershell
   $env:DATABASE_URL = "postgresql://postgres.abcdefgh:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
   npm.cmd run app
   ```

   On the first run this creates every table and seeds the demo catalogue. To
   start empty instead, run `npm run migrate` and then `npm run reindex -- <site> <feed>`.

That is the whole change. Nothing in the application configuration names a
host, so moving between databases is this one variable.

## About TLS

You do not need to put `sslmode=` in the connection string, and you should not
rely on it if you do.

Any host that is not on the local machine gets an encrypted connection with the
certificate verified, decided in `createPool` rather than read from the URL.
That is deliberate: `sslmode=require` is the obvious thing to reach for, and
node-postgres currently treats it as `verify-full` while warning that its next
major version will adopt libpq semantics — where `require` encrypts *without
checking who is on the other end*. An upgrade would silently turn a verified
connection into an unverified one with the connection string unchanged and
nothing in the logs.

- A private CA: `PGSSLROOTCERT=/path/to/ca.crt`.
- `sslmode=disable` in the URL is honoured, because writing it is a decision.
- `COMPASS_DB_SSL_INSECURE=1` accepts any certificate. It logs a warning every
  start, and it means anything able to answer for that hostname can read every
  query. It exists for a self-signed dev server, not for production.

## What this does not solve

**Your catalogue still comes from a feed.** The database holds decisions and
events, not products. The index is rebuilt from `searchspring.txt` or a
NetSuite export, and that file has to reach the machine running the ingest —
hosting Postgres changes nothing about it.

If the goal is for the feed itself to live somewhere durable, commit it to this
repository or drop it in Drive. Both survive any particular machine, and both
can be read without credentials being handed around.

## Cost and limits

Supabase's free tier is 500 MB and pauses after a week of inactivity — fine for
trying this, not for a storefront. The events table is what grows: roughly one
row per search and per click. A store doing 50,000 searches a month writes on
the order of 100 MB a year before the nightly rollup trims it, so a paid tier
is the realistic starting point for production.

Back it up with the tooling already here rather than relying on the provider
alone:

```bash
npm run backup -- --out ./backups
```

See `docs/OPERATIONS.md` for the restore drill.
