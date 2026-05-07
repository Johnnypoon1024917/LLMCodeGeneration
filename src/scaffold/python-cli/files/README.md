# my-cli

A Python CLI scaffolded by NexusCode.

## Setup

Using uv (recommended for speed):

```bash
uv venv
uv pip install -e .
```

Using pip:

```bash
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -e .
```

## Run

```bash
my-cli                           # default greeting
my-cli --name Johnny             # custom name
my-cli alpha beta --verbose      # positional + flag
```

Or directly without install:

```bash
python src/my_cli/main.py --name Johnny
```

## Develop

The entry point is `src/my_cli/main.py`. Add new flags via
`build_parser()` or split logic into separate modules under
`src/my_cli/`. The `[project.scripts]` entry in `pyproject.toml`
maps the `my-cli` command to `my_cli.main:main`.
