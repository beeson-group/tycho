# AGENTS.md

TyCHO has two halves, which are released together at one version. pytycho (Python) writes a scene, i.e. the scene document `scene.tys` (JSON that specifies what to draw) and the data container `data.tyd` (the arrays), from NumPy arrays. It then inlines the browser runtime (TypeScript, `@beeson-group/tycho`) into one HTML page, which draws the scene.

## Layout

- `src/pytycho/` holds the `Scene` builder (`scene.py`), the data container (`container.py`), the evaluator (`_evaluate.py`, which computes what each panel draws at a frame index), thinning (`_thin.py`, which keeps a subset of the stored samples), and the page writer (`html.py`, `template.html`). Its `_static/tycho.js` is the built runtime, which is gitignored and shipped in the wheel, hence it has to be built in a fresh checkout before pytycho can write a page.
- `web/src/` holds the runtime, i.e. the container and scene readers, the evaluator (`evaluate/`), and the `<tycho-viewer>` element with its renderer (`runtime/`). The file `scene.gen.ts` is generated from the schema by `npm run gen:types`. Never edit it by hand, since a test fails when it differs from the types generated from the schema.
- `spec/` holds the format rules, the JSON Schema, and the conformance corpus, i.e. scenes with the answers that both evaluators must give.
- `tests/` holds the pytest suite, and `web/test/` holds the vitest suite of the runtime.
- `examples/` holds the Broucke example, which builds its page from `broucke-input.tyd`, a file attached to each GitHub Release. The input and the outputs are gitignored.
- `docs/` holds the Sphinx site. `skills/tycho/` holds the agent skill for people who use pytycho, and `.claude-plugin/` holds its plugin manifests, which make the repository a Claude Code plugin marketplace.

## Commands

```sh
npm --prefix web ci && npm --prefix web run build   # the runtime, into web/dist and src/pytycho/_static
npm --prefix web test && npm --prefix web run typecheck
uv run pytest
uvx pre-commit run --all-files                      # ruff, pyright, prettier --check, codespell, schema checks
uvx nox -s docs                                     # the site, into docs/_build/html
uvx nox -s build                                    # the sdist and the wheel, into dist/
python3 .github/check_versions.py                   # the four version fields agree
```

## Conventions

- Python lines run to 140 columns and are formatted by ruff. TypeScript lines run to 160 columns, use single quotes, and are checked by prettier, which only reports a misformatted file. Run `npx prettier --write <file>` from `web/` to apply the change.
- Where the Python and the TypeScript evaluators disagree, the answer in the corpus in `spec/` holds. Reword the rule to match it, add a case when the corpus does not cover the disagreement, and then fix both implementations.
- A version bump touches `src/pytycho/__init__.py`, `web/package.json`, and the two files in `.claude-plugin/` together, and `python3 .github/check_versions.py` fails while the four disagree.
- Every user-visible change gets a line under `## [Unreleased]` in `CHANGELOG.md`, since this section becomes the notes of the next release.
