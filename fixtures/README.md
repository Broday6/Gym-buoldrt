# Catalogue fixtures

Somewhere to put a real catalogue feed, so the relevance suite and the ingest
can be run against it rather than against the generated demo catalogue:

```bash
npm run relevance -- --csv fixtures/searchspring.txt
npm run reindex -- <site> fixtures/searchspring.txt
```

The delimiter is detected from the header row, so a tab-separated `.txt`, a
comma-separated `.csv` and a pipe-separated export all work unchanged.

## Before you commit anything here

**This repository is public.** Anything added is world-readable, and git
history keeps it after a delete.

That is fine for a feed already published at a public URL — a Searchspring feed
is served openly for Searchspring to crawl, so committing it discloses nothing
new. It is not fine for a NetSuite export or any saved-search pull: those carry
internal record ids, item-setup templates and unlaunched products, none of
which are public today.

For anything in that second category, keep it out of the repository and hand it
over another way — Google Drive works, and so does making this repository
private.

Nothing is committed here yet, and `.gitignore` deliberately does not exclude
this directory: the choice of what goes in is a decision to make deliberately,
not one to have made silently by a pattern.
