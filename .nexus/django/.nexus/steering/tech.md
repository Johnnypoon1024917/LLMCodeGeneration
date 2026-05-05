# Tech

## Stack

- Python 3.11+
- Django 4.2 / 5.x
- Django REST Framework
- PostgreSQL (assume; adjust if you use MySQL/SQLite)
- Celery for background work (when used)

## ORM discipline

- **No N+1 queries in hot paths.** Use `select_related()` for
  foreign-key joins and `prefetch_related()` for reverse and m2m.
  When generating list-view code, the agent should ALWAYS pair
  the queryset with appropriate `*_related()` calls.
- **Manager methods, not view-side filters.** If the same `.filter(...)`
  appears in two views, factor into a `Manager` method on the model.
  Views should read like business logic, not ORM tutorials.
- **`bulk_create` / `bulk_update` for >10-row writes.** Single-row
  ORM saves in a loop are an anti-pattern.
- **Use `F()` and `Q()` instead of round-tripping through Python**
  for arithmetic / boolean composition.

## Transactions

- Production runs with `ATOMIC_REQUESTS = True`. Don't write code
  that depends on partial commits.
- Long-running operations that span requests use
  `transaction.atomic()` blocks AND background tasks — not request
  handlers.

## Migrations

- Every model change is accompanied by a generated migration.
- Migrations are committed to source control. NEVER edit a migration
  after it's been applied to staging.
- Renames use `RenameField` / `RenameModel`, never delete + add.
- Data migrations live in their own migration file, separate from
  schema migrations, and are documented at the top with a
  `# data: <description>` comment.

## DRF conventions

- `ModelSerializer` for CRUD; hand-rolled `Serializer` for non-model
  endpoints.
- `ViewSet` over `APIView` when the resource fits the CRUD shape.
  Custom actions via `@action(detail=True/False)`.
- Permission logic lives in `permissions.py` per app, not inlined
  in views.
- Pagination is set globally in `REST_FRAMEWORK` settings, not
  per-view, unless the view has a documented reason to differ.

## Settings + secrets

- `SECRET_KEY`, DB credentials, third-party API keys come from
  environment variables (or a secret manager), NEVER from `settings.py`.
- Different settings modules for `dev` / `staging` / `production`,
  with shared `base.py`.
- `DEBUG = True` only in `dev`. The agent should refuse to flip it
  on elsewhere.

## Testing

- Tests live in each app's `tests.py` or `tests/` directory.
- Factories (`factory_boy` / `model_bakery`) preferred over fixture
  JSON for test data.
- Database tests use Django's `TestCase` (not `TransactionTestCase`)
  unless transaction rollback is specifically needed — much faster.
- Every PR adds tests for the code it changes. Coverage is a
  reviewer judgment, not a CI gate.
