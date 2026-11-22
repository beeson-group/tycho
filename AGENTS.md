# AGENTS.md

With TyCHO, users turn trajectories computed by other libraries into pages. A page is one HTML file with an animated, interactive picture of them. Users write scenes from NumPy arrays with pytycho (Python, in `src/`). pytycho writes each scene into a page together with the runtime (TypeScript, in `web/`, published on npm as `@beeson-group/tycho`), which draws it in the browser. The two packages are released together at one version.

<!-- shared:begin -->
## Hard invariants

Hard invariants are never traded away for other goals. When a change would break one, stop and ask the person you work for. Conventions may be argued with.

1. Phones are supported.
2. Great performance on slow machines is always an objective.
3. The best part is no part. Complexity is never favored when a simpler solution exists.
<!-- shared:end -->
4. Physics is not computed in the runtime. Stored samples are only rotated, scaled, translated, or blended linearly in pairs.
5. Pages are single files that work offline. The data and the runtime are embedded, and nothing is fetched while a page is viewed.
6. Dependencies are not added to the runtime beyond three.js and mp4-muxer.
7. Every feature is supported in all browsers. Pages can be viewed and presented, and every control can be used, in current Chrome, Firefox, and Safari, on desktops and phones. Extras such as the video export may be missing in one browser. The user is then told so in a message.

## Where things are

- The built runtime, `src/pytycho/_static/tycho.js`, is gitignored and shipped in the wheel. pytycho cannot write pages until you build it. Rebuild it after every change in `web/`.
- `web/src/scene.gen.ts` is generated from `spec/scene.schema.json`. Never edit it by hand. A test fails when it differs from the generated types.
- The format rules, the JSON Schema, and the conformance corpus are kept in `spec/`. Each corpus scene is stored with the answers that both evaluators must give. The evaluators are `src/pytycho/_evaluate.py` and `web/src/evaluate/`.
- The inputs of the Broucke and manifolds examples are gitignored and attached to each GitHub Release. How to download them is described in the docstring of each `build.py`. Example tests are skipped while their inputs are missing. Hence the examples may be broken even when `uv run pytest` is green.
- The skill in `skills/tycho/` is written for pytycho users. It is shipped through the plugin manifests in `.claude-plugin/`. Skills for work on this repository are kept in `.agents/skills/`.

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

Start Chrome only with `Chrome.launch` of `web/test/chrome-driver.ts` or with the scripts in `web/scripts/`, and never end it with `kill` or `pkill`. On macOS, a Chrome that is started without the arguments of `chromeArgs` in `web/scripts/chrome.mjs` copies its app into a temp folder, and this copy is left behind when Chrome is ended by a signal.

## Before you hand work over

- Run `uvx pre-commit run --all-files`, `uv run pytest`, `npm --prefix web test`, and `npm --prefix web run typecheck`. Hand work over only when all four pass.
- Also run `uvx nox -s docs` when you change `docs/`, `spec/`, or docstrings. Run `uv run --python 3.10 --resolution lowest-direct pytest` when you change a lower bound in `pyproject.toml`.
- NEVER assume the failure was there before your change.

<!-- shared:begin -->
## Issues and branches

- Before you start a change, search the open issues, the open PRs, and the remote branches for the same work, and report what you find to the person you work for.
- Start changes from GitHub issues. Issues are not needed for changes under about 20 lines, documentation-only changes, or dependency bumps.
- Extend an existing issue when the change belongs to it, rather than opening a new one. Open separate issues for bugs that reproduce on `main`.
- The issue type is `Bug` for a crash, a regression, or unintended behavior, `Feature` for behavior that the repository does not have yet, and `Task` for a refactor or performance improvement without new behavior.
- Write a `Bug` under the headings Expected behavior, Actual behavior, Reproduction on `main`, and Version and browser.
- Write feature issues under the headings Idea, Hard requirements, and Soft requirements.
- Name your branch `<surname>/<N>-<two-or-three-words>` in lowercase, where the surname is the one of the person you work for and `N` is the number of the issue. Leave `<N>-` out when the change does not have an issue.
<!-- shared:end -->

## Commits and PRs

- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
<!-- shared:begin -->
- Open GitHub descriptions and comments with the line `:robot: Generated by <harness>:<model>, not yet reviewed by the author :robot:`, where `<harness>` is the name of your harness and `<model>` is the id of your model.
- Write `Closes #N` on the line below the attribution line, and NEVER repeat the text of the issue in the description.
- Show every UI change in the description of the PR, not in a comment, as one image with the state before on the left and the state after on the right. Show motion or timing as one short video with both states side by side. Write the video alone in its paragraph, so that it is played in place.
- Take the images and videos yourself, and upload them without asking. Write each into the body file as `![alt](./file.png)`, and name the file with `--attach` of `gh pr create` or `gh pr edit`, in `gh` 2.99 or later. Keep each file under 10 MB, and a video in H.264 as MP4.
- Never commit PR-only screenshots or assets such as `.github/pr-assets/`, and never upload them anywhere but GitHub.
- Mark a PR as ready for review only when every check is green and the person you work for agrees.
- If you think CI itself is broken, say so in the description but DO NOT change CI unless explicitly instructed to do so.
- Watch CI until everything is green. DO NOT hand over until you have fixed all CI problems, and addressed `pr-agent` code reviews.
- Merge a PR only when you are told to by the person you work for.
<!-- shared:end -->
- Add a line for every user-visible change under `## [Unreleased]` in `CHANGELOG.md`, in the sections of Keep a Changelog (Added, Changed, Deprecated, Removed, Fixed, and Security).

<!-- shared:begin -->
## Reviewing a PR

PR-Agent reviews PRs in the workflow `pr-agent`. A person needs effective write access to start a review. Authorized commands review any PR, one opened by a bot included.

- Treat the hard invariants above as the review criteria, and name the invariant that a finding breaks. A change that breaks one is a finding to fix before the PR is merged, not a suggestion.
<!-- shared:end -->
- Do not suggest changes in `web/src/scene.gen.ts`. It is generated from `spec/scene.schema.json`. Review the schema instead.
- Changes to expected answers in the conformance corpus are right only together with the change that justifies them. The corpus is taken as right where the two evaluators disagree.

## Conventions

- Python lines run to 140 columns and are formatted with ruff. TypeScript lines run to 160 columns and use single quotes. In the hooks, TypeScript is checked with prettier but not rewritten. Apply fixes with `npx prettier --write <file>` from `web/`.
- Start scene-format changes in `spec/`, with a conformance case that both evaluators pass.
- Where the two evaluators disagree, the corpus answer is taken as right. Reword the rule to match it. Add a case when the disagreement is not covered by the corpus. Then fix both implementations.
- Bump the version in `src/pytycho/__init__.py`, `web/package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` together. `python3 .github/check_versions.py` fails while the four disagree.

## Documentation and writing

- Renderer changes are not written into `spec/`.
- Write each fact in one place, and link to it from the others.
- In `spec/` and `docs/`, put each sentence on its own line.
- `README.md` is hand-written for human readers by the maintainers, in their voice. If you have to edit it, keep this voice, and do not restyle it to the rules below.
- In docs, docstrings, and comments, write for readers who have only the text. Name each thing at its first mention.
- Write complete sentences with one claim each. Do not use semicolons or em dashes. Use American spelling and the serial comma.
- Describe the current state. Leave its history to the commits and the changelog.
- Keep comments short. Write them only for what the code cannot show.

## Terms

- Words with a narrower meaning than usual are defined in `GLOSSARY.md`.
- Before you coin a word, use the word that astrodynamics, NumPy, matplotlib, Plotly, or everyday English already has.
- Give narrowed and coined words an entry in `GLOSSARY.md` as soon as they are settled. Name things in the code after the glossary.
- Keep one meaning per word across pytycho, the runtime, the schema, and the docs.

## Releasing

To release, follow the skill in `.agents/skills/release/SKILL.md`.

## Sibling repository

slides (`https://github.com/beeson-group/slides.git`) is the group's template for talks as HTML slides. A TyCHO viewer can be put on one of its slides. Read its `AGENTS.md` before you change it.
