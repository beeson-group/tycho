---
name: release
description: Use when someone wants to release TyCHO, publish pytycho or @beeson-group/tycho, try a release candidate on TestPyPI, bump the version, refresh the GIF of the README, or set up the registries and Read the Docs for publishing.
---

# Release TyCHO

pytycho and `@beeson-group/tycho` are released together from one tag, and both packages are given one build of the runtime. Each package is published from the workflow `.github/workflows/cd.yml` through trusted publishing, i.e. with OpenID Connect, without a stored token, and a person approves each publish on its environment before it runs.

## Release a version

1. Set the version `X.Y.Z` in `src/pytycho/__init__.py`, `web/package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, and run `python3 .github/check_versions.py`, which fails while the four disagree.
2. Print the hashes of the example inputs with `shasum -a 256 examples/*/*-input.tyd`. Set `INPUT_SHA256` in `examples/broucke/build.py` and in `examples/manifolds/build.py` to the hashes of the `broucke-input.tyd` and the `manifolds-input.tyd` that you will attach to the release, so that each page is built only from its released input.
3. Rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`, and start a new empty `## [Unreleased]` above it. Keep the opening paragraph of the section, with the versions of the scene document and the data container that the packages read and write. At the bottom of the file, point the link of `[Unreleased]` at `vX.Y.Z...HEAD`, and add a link for `[X.Y.Z]`.
4. For a release candidate, i.e. a trial version published before the release, set the version to `X.Y.ZrcN` in the four files and run `cd.yml` by hand. Once a person approves the environment `testpypi`, pytycho is uploaded to TestPyPI, the test instance of PyPI. Nothing is published to npm, since a test registry does not exist on npm. Install the release candidate in a clean environment, open a page that it writes, and set the version back to `X.Y.Z`.
5. Once the pull request with steps 1 to 3 is merged into `main`, tag `vX.Y.Z` on `main` and publish a GitHub Release from the tag, with the changelog section as its notes. If you add the notes generated on GitHub, the pull requests of Dependabot and pre-commit.ci are left out of them, as configured in `.github/release.yml`.
6. When you publish the release, `cd.yml` is started, and the tag, the four versions, and the changelog are checked against each other in it. The runtime is then built once, tested, and packed, and both packages are published after a person approves the environment `pypi` or `npm`.

## Attach the examples and the GIF

Run the steps below from the repository root of a checkout of the tag, with the runtime built, the two inputs of step 2 in `examples/broucke/` and `examples/manifolds/`, and Google Chrome and ffmpeg installed.

1. Build the two example pages.
   ```sh
   uv run python examples/broucke/build.py
   uv run python examples/manifolds/build.py
   ```
2. Take the poster of each page, i.e. the still shown above the link to the page in the gallery of the docs, at 1920 by 1080 in the middle of the loop.
   ```sh
   node web/scripts/poster.mjs examples/broucke/broucke.html examples/broucke/broucke.png
   node web/scripts/poster.mjs examples/manifolds/manifolds.html examples/manifolds/manifolds.png
   ```
3. Convert the screen recording of the Broucke page to the GIF of the README. Claudio Vestini records this video for each release, while he uses the page in a full-screen browser, hence ask him for the file. The picture of the README is loaded from `https://github.com/beeson-group/tycho/releases/latest/download/broucke.gif`, hence it is broken whenever this file is missing from the latest release. Add `-t SECONDS` before each `-i recording.mov` to cut the end of the recording, where the browser bar or the recording controls come into view.
   ```sh
   ffmpeg -v error -y -i recording.mov -vf "setpts=PTS/1.5,fps=15,scale=960:-2:flags=lanczos,palettegen=max_colors=256:stats_mode=full" broucke-palette.png
   ffmpeg -v error -y -i recording.mov -i broucke-palette.png -lavfi "setpts=PTS/1.5,fps=15,scale=960:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" -loop 0 broucke.gif
   ```
4. Upload the pages, the posters, the inputs, and the GIF to the release.
   ```sh
   gh release upload vX.Y.Z examples/broucke/broucke.html examples/broucke/broucke.png examples/broucke/broucke-input.tyd examples/manifolds/manifolds.html examples/manifolds/manifolds.png examples/manifolds/manifolds-input.tyd --clobber --repo beeson-group/tycho
   gh release upload vX.Y.Z broucke.gif --repo beeson-group/tycho
   ```
5. Delete `broucke-palette.png` and `broucke.gif` from the repository root, since they are not gitignored there.
6. Rebuild the versions `stable` and `latest` from the dashboard of Read the Docs, so that the new pages are shown in the gallery, since both versions were built before the pages were attached.

## One-time setup

1. Register a trusted publisher, i.e. the record on a registry of the workflow and the environment that may publish a package. Register one for `pytycho` on pypi.org (workflow `cd.yml`, environment `pypi`) and on test.pypi.org (workflow `cd.yml`, environment `testpypi`), and one for `@beeson-group/tycho` on npmjs.com (workflow `cd.yml`, environment `npm`).
2. Create the three environments `pypi`, `testpypi`, and `npm` in the settings of the repository, each with required reviewers, so that a publish runs only after a person approves it.
3. Import the Read the Docs project `pytycho` from the repository with the builds of pull requests turned on, for which the Read the Docs GitHub App must be installed on the organization.
4. Set the default version of the project to `stable` once the first tag is built.
