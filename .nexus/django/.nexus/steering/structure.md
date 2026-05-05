# Structure

## Layout

Standard Django-with-multi-app layout:

- `apps/<app_name>/` — each Django app
  - `models.py` — model definitions
  - `views.py` or `views/` — views (ViewSets / APIViews)
  - `serializers.py` — DRF serializers
  - `permissions.py` — permission classes
  - `tests/` or `tests.py` — tests
  - `migrations/` — auto-generated, hands off
- `config/` — project settings (`base.py`, `dev.py`, `production.py`)
- `manage.py` — Django entrypoint
- `pyproject.toml` / `requirements/` — dependencies

If your project uses a flatter layout (apps directly at the repo
root, no `apps/` parent), edit this file accordingly.

## Tests live with the code

Each app has its own `tests/` directory or `tests.py` file. There is
NO project-level `tests/` tree.

## Exclude paths

The agent should not read these directories. They are auto-generated,
binary, or out-of-scope for code review:

- migrations/
- static/
- staticfiles/
- media/
- node_modules/
- .venv/
- venv/
- env/
- __pycache__/
- .pytest_cache/
- .tox/
- htmlcov/
- dist/
- build/
- *.egg-info/
