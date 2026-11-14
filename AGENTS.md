# AGENTS.md

With TyCHO, a user turns trajectories that another library has computed into a page, i.e. one HTML file with an animated, interactive picture of them. The user writes a scene from NumPy arrays with pytycho (Python, in `src/`), and pytycho writes it into the page together with the runtime (TypeScript, in `web/`, published on npm as `@beeson-group/tycho`), which draws it in the browser. The two packages are released together at one version.

## Hard invariants

A hard invariant is never traded away for another goal, and when a change would break one, you stop and ask the person you work for. A convention may be argued with.

1. Physics is not computed in the runtime, where a stored sample is only rotated, scaled, translated, or blended linearly with a second stored sample.
2. A page is one file that works offline, since the data and the runtime are embedded in it and nothing is fetched while it is viewed.
3. A dependency is not added to the runtime beyond three.js and mp4-muxer.
4. Every feature is supported in all browsers, i.e. a page can be viewed and presented, and every control can be used, in current Chrome, Firefox, and Safari on a desktop and on a phone. An extra such as the video export may be missing in one browser, and the user is then told so in a message.
5. Phones are supported.
6. Performance on a slow machine is always an objective.

## Where things are

- The built runtime, `src/pytycho/_static/tycho.js`, is gitignored and shipped in the wheel. pytycho cannot write a page until you build it, and you rebuild it after every change in `web/`.
- The file `web/src/scene.gen.ts` is generated from `spec/scene.schema.json`. Never edit it by hand, since a test fails when it differs from the generated types.
- The format rules, the JSON Schema, and the conformance corpus are kept in `spec/`. In the corpus, each scene is stored with the answers that both evaluators, `src/pytycho/_evaluate.py` and `web/src/evaluate/`, must give.
- The inputs of the Broucke and the manifolds examples are gitignored and attached to each GitHub Release, and the way to download each is described in the docstring of its `build.py`. The tests of an example are skipped while its input is missing, hence the examples may be broken even when `uv run pytest` is green.
- The skill in `skills/tycho/` is written for people who use pytycho, and it is shipped through the plugin manifests in `.claude-plugin/`. The skills for work on this repository are kept in `.agents/skills/`.

## Commands

```sh
npm --prefix web ci && npm --prefix web run build   # the runtime, into web/dist and src/pytycho/_static
npm --prefix web test && npm --prefix web run typecheck
npm --prefix web run gen:types                      # web/src/scene.gen.ts, after a change of the schema
uv run pytest
uvx pre-commit run --all-files                      # every hook of .pre-commit-config.yaml
uvx nox -s docs                                     # the site, into docs/_build/html
uvx nox -s build                                    # the sdist and the wheel, into dist/
python3 .github/check_versions.py                   # the four version fields agree
node web/scripts/frame-profile.mjs <page.html>      # the cost of playback, in headless Chrome
```

## Before you hand work over

- Run `uvx pre-commit run --all-files`, `uv run pytest`, `npm --prefix web test`, and `npm --prefix web run typecheck`, and hand work over only when all four pass.
- Run `uvx nox -s docs` as well when you changed `docs/`, `spec/`, or a docstring, and `uv run --python 3.10 --resolution lowest-direct pytest` when you changed a lower bound in `pyproject.toml`.
- Do not assume that a failure was there before your change.

## Issues and branches

- Before you start a change, search the open issues, the open pull requests, and the remote branches for the same work, and report what you find to the person you work for.
- Start a change from a GitHub issue. An issue is not needed for a change of under about 20 lines, a change of the documentation alone, or a dependency bump.
- Extend an existing issue when the change belongs to it, rather than opening a new one. Open a separate issue for a bug that can be reproduced on `main`.
- Open an issue with `gh issue create --type`, since the issue forms of the group cannot be filled in from the terminal. The type is `Bug` for a crash, a regression, or unintended behavior, `Feature` for behavior that the repository does not have yet, and `Task` for an investigation, a refactor, or a performance improvement without new behavior.
- Write a `Bug` under the headings What happened, What you expected, Steps or a minimal script to reproduce, and Version and browser. Write any other issue under the headings The problem, What you would like, and Alternatives.
- Name a branch `<surname>/<N>-<two-or-three-words>` in lowercase, where the surname is the one of the person you work for and `N` is the number of the issue. Create it with `gh issue develop <N> --name <branch> --checkout`, and leave `<N>-` out when the change does not have an issue.

## Commits and pull requests

- Start a bug fix from a regression test that fails for the reported reason, and commit this test first, alone, before the fix.
- Give each commit one purpose. Write its subject as a lowercase phrase that opens with an imperative verb, without an article at the start or a prefix such as `fix:`, and write the subject of a regression test as `add regression test:` followed by the behavior.
- Do not add an attribution line, such as `Co-Authored-By`, to a commit message.
- Open every issue description, pull request description, and comment that you write with the line `:robot: Generated by <harness>:<model>, not yet reviewed by the author :robot:`, where `<harness>` is the name of your harness and `<model>` is the id of your model. Delete this line only when the person you work for tells you that they have read the text.
- Open a pull request as a draft with `gh pr create --draft`, and fill in the template of the group. Write `Closes #N` on the line below the attribution line, and do not repeat the text of the issue in the description.
- Mark a pull request as ready for review only when every check is green and the person you work for agrees. When you think that a check itself is broken, say so in the description rather than changing the check.
- The reasons for these rules are explained for people in the [group contributing guide](https://github.com/beeson-group/.github/blob/main/CONTRIBUTING.md).
- Merge a pull request only when you are told to by the person you work for.
- Add a line for every user-visible change under `## [Unreleased]` in `CHANGELOG.md`, in the sections of Keep a Changelog (Added, Changed, Deprecated, Removed, Fixed, and Security). This section becomes the notes of the next release.

## Conventions

- Python lines run to 140 columns and are formatted with ruff. TypeScript lines run to 160 columns and use single quotes. In the hooks, the TypeScript is checked with prettier without being rewritten, hence you apply a fix with `npx prettier --write <file>` from `web/`.
- Start a change of the scene format in `spec/`, with a conformance case that both evaluators pass.
- Where the two evaluators disagree, the answer in the corpus is taken as right. Reword the rule to match it, add a case when the disagreement is not covered by the corpus, and then fix both implementations.
- Bump the version in `src/pytycho/__init__.py`, `web/package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` together, since `python3 .github/check_versions.py` fails while the four disagree.

## Documentation and writing

- A documentation change is not needed for most code changes, since a reader can read the code.
- A change of the renderer is not written into `spec/`.
- Write each fact in one place, and link to it from the others.
- In `spec/` and `docs/`, put each sentence on a line of its own.
- `README.md` is written for a human reader in the first-person voice of Claudio Vestini. When you edit it, keep this voice, and do not restyle it to the rules below.
- In the docs, the docstrings, and the comments, write for a reader who has only the text, and name each thing at its first mention.
- Write complete sentences with one claim each, without semicolons or em dashes, in American spelling with the serial comma.
- Describe the current state, and leave its history to the commits and the changelog.
- Keep a comment short, and write it only for what the code cannot show.

## Terms

- The words with a narrower meaning than usual are defined in `GLOSSARY.md`.
- Before you coin a word, use the word that astrodynamics, NumPy, matplotlib, Plotly, or everyday English already has.
- Give a word with a narrower meaning than usual, or a coined word, an entry in `GLOSSARY.md` the moment it is settled, and name things in the code after the glossary.
- Keep one meaning per word across pytycho, the runtime, the schema, and the docs.

## Releasing

To release, follow the skill in `.agents/skills/release/SKILL.md`.

## Sibling repository

slides (`https://github.com/beeson-group/slides.git`) is the template of the group for talks as HTML slides, and a TyCHO viewer can be put on one of its slides. Read its `AGENTS.md` before you change it.
