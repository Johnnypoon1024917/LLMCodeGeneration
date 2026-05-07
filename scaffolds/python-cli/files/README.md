# my-cli

A Python command-line tool scaffolded by NexusCode. Uses
[Click](https://click.palletsprojects.com/) for argument parsing.

## Setup

A virtual environment is recommended:

```bash
python -m venv .venv
source .venv/bin/activate     # Linux/macOS
.venv\Scripts\activate        # Windows

pip install -e ".[dev]"
```

`-e` installs in editable mode so you can edit source and re-run
without reinstalling. `[dev]` pulls in pytest.

## Run

```bash
my-cli --help                              # show help
my-cli greet --name World                  # → "Hello, World!"
my-cli greet --name World --shout          # → "HELLO, WORLD!"
my-cli sum 1 2 3 4                         # → "10"
my-cli sum 1.5 2.5                         # → "4.0"
```

Or without installing:

```bash
python -m my_cli.cli greet --name World
```

## Test

```bash
pytest
```

## Structure

```
src/my_cli/
├── __init__.py
├── cli.py                  # Entry point — click group, registers subcommands
└── commands/
    ├── __init__.py
    ├── greet.py            # demonstrates --options + flags
    └── sum_cmd.py          # demonstrates positional args with type validation

tests/
└── test_cli.py             # uses click.testing.CliRunner
```

## Adding a new subcommand

1. Create `src/my_cli/commands/<name>.py` with a `@click.command()`-decorated function.
2. Import it in `src/my_cli/cli.py` and call `cli.add_command(<name>)`.
3. Add tests to `tests/test_cli.py`.

Click handles arg parsing, validation, and `--help` for you. Lean on
`click.option` and `click.argument` rather than reaching for `argparse`
or hand-rolled parsing — Click's error messages are better.

## Exit codes

- `0` — success
- `1` — runtime error
- `2` — usage error (Click defaults; unknown option / missing required arg)

## Distribution

To build a wheel:

```bash
pip install build
python -m build              # produces dist/*.whl
```

To install globally on your machine:

```bash
pip install .                # without -e: copies into site-packages
```
