# Contributing to TyCHO

The project follows the [Scientific Python Development Guide](https://learn.scientific-python.org/development/), a set of recommendations for the layout, the packaging, and the checks of a scientific Python project. You need [uv](https://docs.astral.sh/uv/), the Python package and project manager that runs every Python command below, and Node 24 or later, which builds and tests the browser runtime.

## Set up

The three commands below set up a fresh clone. The runtime comes first, since it is not kept in git and pytycho cannot write a page without it.

```sh
npm --prefix web ci && npm --prefix web run build   # the runtime, which pytycho inlines into every page
uv run pytest                                       # creates .venv with pytycho and the test group
uvx pre-commit install                              # runs the checks on every commit
```

## Checks

The command `uvx pre-commit run --all-files` runs every check, i.e. every hook listed in `.pre-commit-config.yaml`, over the whole repository. Here `uvx` runs a Python tool through uv without installing it into the project. The checks are the following.

- The basic hooks of pre-commit-hooks and pygrep-hooks catch general faults, e.g. trailing whitespace, a missing final newline, a leftover merge-conflict marker, or an added file larger than 1024 KB.
- ruff lints and formats the Python code.
- pyright checks the types of the Python code in `src/`, `tests/`, and `examples/`.
- prettier checks the format of the TypeScript in `web/`, in check mode only, since the TypeScript is reformatted by hand.
- codespell flags common misspellings.
- A local hook rejects miscapitalized names of tools, such as NumPy and GitHub written with a wrong capital.
- validate-pyproject checks that `pyproject.toml` is valid.
- The schema checks validate the GitHub workflows, the Dependabot configuration, and the Read the Docs configuration against their JSON Schemas.
- zizmor audits the GitHub workflows for security problems.

Prettier only reports what it would change, and `npx prettier --write <file>`, run from `web/`, applies the change. The other tasks run through nox, as the sessions of `noxfile.py`. A bare `uvx nox` runs the lint and the Python tests, and `uvx nox -s docs` builds the site into `docs/_build/html`. Adding `-- --serve` serves the site on a local web server and rebuilds it on every change. The sdist and the wheel are built by `uvx nox -s build`, which first builds the runtime if it is missing, since the wheel carries the runtime. The checks of the runtime are `npm --prefix web test`, which runs the vitest suite, and `npm --prefix web run typecheck`, which runs the TypeScript compiler as a type checker.

The GitHub Actions workflow `ci.yml` runs the same checks on every pull request and on every push to `main`, in the jobs below.

- pre-commit runs over every file.
- pytest runs on Python 3.10 to 3.14 on Ubuntu, and on 3.10 and 3.14 on macOS.
- pytest also runs on Python 3.10 against the lowest versions that the dependencies allow, i.e. the lower bounds declared in `pyproject.toml`, so that these bounds are known to work.
- The runtime's tests and typecheck run, together with two package checks, publint and arethetypeswrong, which check how the npm package and its type declarations resolve for a user.
- Both distributions, the sdist and the wheel, are built, and their contents are checked, e.g. that the wheel carries the runtime and the license notices.

The script `web/scripts/frame-profile.mjs` measures what a frame of playback costs. The command `node web/scripts/frame-profile.mjs examples/broucke/broucke.html --set family=11 --set branch=apoapsis` times the frames that the page draws, in headless Chrome (Chrome without a window) on the GPU of the machine it runs on. Each `--set` fixes a scene-scoped variable of the page, here the family and the branch of the Broucke example. The option `--compare-cache` checks the static-layer cache against drawing every layer, by comparing the two sets of frames pixel by pixel. This cache holds the layers that do not move during playback, which are drawn once and copied back every frame. The option `--drag e:0:0.45` times a slider drag, i.e. 240 paused frames that move the selector `e`, the eccentricity, from 0 to 0.45. The timings rank costs and show regressions, rather than predict the frame rate of a display. The script requires Google Chrome and a built example page.

The script `web/scripts/video.mjs` exports the video of a page with the viewer's `exportVideo`, in headless Chrome, and writes the MP4 and a poster, which is the last frame by default. The video of the manifolds example for a portrait zone of the talk template is exported from the slide variant of each mode, e.g. for the dark mode with the commands below. The font file is the Latin Modern Roman of the template, and for the light mode `light` is written in place of `dark`.

```sh
python examples/manifolds/build.py --slide dark
node web/scripts/video.mjs examples/manifolds/manifolds-slide-dark.html manifolds-dark.mp4 --size 1200x1600 --dpr 2 --fps 60 --theme dark --font latin-modern-roman-400-normal.woff2
```

## Changes

Add a line for every user-visible change under `## [Unreleased]` in `CHANGELOG.md`, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections (Added, Changed, Deprecated, Removed, Fixed, and Security). This section becomes the notes of the next GitHub Release. A change to the scene format starts in `spec/`, with a conformance case that both evaluators pass, since the spec is the contract between pytycho and the runtime.

## Releasing

pytycho and `@beeson-group/tycho` are released together, from one tag. The runtime is built once for both, hence the two packages carry the same bundle.

1. Set the version in `src/pytycho/__init__.py`, `web/package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, and confirm with `python3 .github/check_versions.py` that the four agree. Set `INPUT_SHA256` in `examples/broucke/build.py` and in `examples/manifolds/build.py` to the SHA-256 hashes of the `broucke-input.tyd` and the `manifolds-input.tyd` to be attached to the Release, as printed by `shasum -a 256 examples/*/*-input.tyd`. Any other input file is then rejected, so that each page is always built from the released input.
2. Rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`, start a new empty `## [Unreleased]`, and update the links at the bottom, one per version heading.
3. For a release candidate, i.e. a trial version published before the release, set the version to `X.Y.ZrcN` and run the workflow `cd.yml` by hand. It uploads pytycho to TestPyPI, the test instance of PyPI, once a reviewer approves the deployment to the `testpypi` environment. It does not publish anything to npm, which lacks a test registry. Install the release candidate in a clean environment and open a page that it writes.
4. Tag `vX.Y.Z` on `main` and publish a GitHub Release from the tag, with the changelog section as its notes. Publishing the Release runs `cd.yml`, which checks that the tag, the four versions, and the changelog agree. The workflow then builds the runtime once, tests, packs, and publishes both packages through trusted publishing, i.e. with OpenID Connect, which works without any stored token. Each publish waits for approval on its environment, `pypi` or `npm`.
5. Build the two example pages with `python examples/broucke/build.py` and `python examples/manifolds/build.py`. Take the poster of each page for the gallery, i.e. the still image that the documentation shows above the link to the page. A poster is a 1920 by 1080 still at the middle of the loop, taken with `node web/scripts/poster.mjs examples/broucke/broucke.html examples/broucke/broucke.png` and `node web/scripts/poster.mjs examples/manifolds/manifolds.html examples/manifolds/manifolds.png`, which require Google Chrome. Upload the pages, the posters, and the inputs of the examples to the Release (`gh release upload vX.Y.Z examples/broucke/broucke.html examples/broucke/broucke.png examples/broucke/broucke-input.tyd examples/manifolds/manifolds.html examples/manifolds/manifolds.png examples/manifolds/manifolds-input.tyd --clobber`). Then rebuild `stable` and `latest` from the Read the Docs dashboard for the gallery to show the new pages, since both versions were built before the pages existed.

Releasing requires a one-time setup, in the steps below.

1. Register a trusted publisher, i.e. the record on a registry of the workflow and the environment that may publish a package. Register one for `pytycho` on pypi.org (workflow `cd.yml`, environment `pypi`) and on test.pypi.org (workflow `cd.yml`, environment `testpypi`), and one for `@beeson-group/tycho` on npmjs.com (workflow `cd.yml`, environment `npm`).
2. Create the three environments in the repository settings, with required reviewers, so that a publish runs only after a person approves it.
3. Import the Read the Docs project `pytycho` from the repository with pull request builds turned on, which requires the Read the Docs GitHub App on the organization.
4. Set its default version to `stable` once the first tag is built.
