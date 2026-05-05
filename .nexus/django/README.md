# nexuscode-power-django

A NexusCode Power for Django + Django REST Framework projects. Steers
the agent toward Django-idiomatic code: `Manager` methods over raw
querysets in views, `ModelSerializer` over hand-rolled JSON, signals
where they earn their keep, migrations checked in for every model
change.

## What this bundle does

Three steering files:

- **`product.md`** — minimal scaffolding; the user is expected to
  customise it with their actual product domain. The non-trivial
  rules live in `tech.md`.
- **`tech.md`** — Django + DRF conventions. `select_related` /
  `prefetch_related` discipline, no N+1 queries in hot paths, model
  managers for non-trivial filters, ATOMIC_REQUESTS expected.
- **`structure.md`** — typical Django app layout + `## Exclude paths`
  for `migrations/`, `static/`, `media/`, virtual envs.

One hook:

- **`migration-check-on-save.md`** — fires when a `models.py` is
  saved. Asks the agent to flag schema changes that need a new
  migration but don't have one yet.

## Install

```bash
cp -r path/to/nexuscode-power-django/.nexus ./
```

## Customisation

Most users will want to:

1. Edit `product.md` with their actual app's domain.
2. Add organisation-specific rules to `tech.md` — e.g. preferred
   serializer base class, custom permission patterns.
3. Adjust the migration-check hook's pattern if your apps live
   somewhere other than `apps/`.
