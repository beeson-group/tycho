# Typed Celestial HTML Observer (TyCHO)

[![PyPI version](https://img.shields.io/pypi/v/pytycho)](https://pypi.org/project/pytycho/) [![npm version](https://img.shields.io/npm/v/@beeson-group/tycho)](https://www.npmjs.com/package/@beeson-group/tycho) [![Python versions](https://img.shields.io/pypi/pyversions/pytycho)](https://pypi.org/project/pytycho/) [![CI](https://github.com/beeson-group/tycho/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/beeson-group/tycho/actions/workflows/ci.yml) [![Documentation](https://readthedocs.org/projects/pytycho/badge/?version=latest)](https://pytycho.readthedocs.io/) [![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff) [![uv](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/uv/main/assets/badge/v0.json)](https://github.com/astral-sh/uv) [![DOI](https://zenodo.org/badge/1396745013.svg)](https://zenodo.org/badge/latestdoi/1396745013)

TyCHO is our tool for making animated, interactive astrodynamics visualizations.

We created it from one idea: in the era of agentic coding, astrodynamics data visualization has no excuse to remain static, colorless, or otherwise dull.

![Broucke families in the elliptic restricted three-body problem](https://github.com/beeson-group/tycho/releases/latest/download/broucke.gif)

You can check out live examples at our [gallery](https://pytycho.readthedocs.io/en/stable/gallery.html). Playing around is encouraged!

## What TyCHO produces

Each visualization is a single, portable HTML file, which we shall call _page_. You can open this page with a simple double click, from any machine that has a browser (mobile included), offline. Each page is interactive by design, with an intuitive user interface (UI) that needs no explanation or tutorial.

You can also embed the page in a website, retaining the interactive UI elements, or on a slide of an HTML presentation (see our [slides repo](https://github.com/beeson-group/slides) for examples).

## How TyCHO works

TyCHO is not a physics engine, but it does plot real data.

The core idea is:
1. Generate your data from your preferred choice of trajectory optimization software (as of [v0.3.0](https://github.com/beeson-group/tycho/releases/tag/v0.3.0), only [pydylan](https://github.com/beeson-group/pydylan) is supported for this step);
2. Call `pytycho`, our python package that takes your data and efficiently compresses it into binary containers (one `data.tyd` and one `scene.tys` file, for the data and metadata respectively);
3. Draw the scene in the browser with our runtime renderer (built on [three.js](https://threejs.org/)).

## Installing and using TyCHO

Install `pytycho` with the command below. The only requirements are Python and NumPy.

```sh
pip install pytycho
```

From here, we recommend checking out our [quick start](https://pytycho.readthedocs.io/en/stable/quickstart.html).

## Using TyCHO with a coding agent

You can also ask your favorite coding agent to build a visualization for you. For this purpose, we ship a [skill](https://github.com/beeson-group/tycho/tree/main/skills/tycho), i.e. a reusable prompt we crafted so that your agent will know how to write a TyCHO scene from _your_ data.

From the Claude Code harness, you can also load the skill as a plugin from the marketplace with the command below.

```sh
claude plugin marketplace add beeson-group/tycho && claude plugin install tycho@beeson-group
```

For Codex, Cursor, Copilot, Gemini CLI, OpenCode, and other harnesses, you can install the same skill with the command below.

```sh
npx skills add beeson-group/tycho
```

## Contributing

This repository is made of two halves, the Python package `pytycho` (in `src/`) and a TypeScript renderer that draws the page (the runtime, in `web/`). Follow the steps below to set up both on your machine.

1. Install [git](https://git-scm.com/downloads), [Node.js](https://nodejs.org/) version 24 or later (which comes with npm), and [uv](https://docs.astral.sh/uv/).
2. Clone the repository, and move into it.
   ```sh
   gh repo clone beeson-group/tycho
   cd tycho
   ```
3. Build the runtime. Run this again if you change anything in `web/`.
   ```sh
   npm --prefix web ci && npm --prefix web run build
   ```
4. Run the test suites. The first run of `uv run` will also create a virtual environment in `.venv`.
   ```sh
   uv run pytest
   npm --prefix web test
   ```
5. Turn on the pre-commit checks.
   ```sh
   uvx pre-commit install
   ```

Before you open a pull request, please also read our group's [contributing guide](https://github.com/beeson-group/.github/blob/main/CONTRIBUTING.md).

## License

TyCHO is licensed under [Apache-2.0](https://github.com/beeson-group/tycho/blob/main/LICENSE). We also bundle two libraries under the MIT license into every page: three.js (for the renderer), and mp4-muxer (for video exports). See [NOTICE](https://github.com/beeson-group/tycho/blob/main/NOTICE) and [THIRD_PARTY_NOTICES.md](https://github.com/beeson-group/tycho/blob/main/THIRD_PARTY_NOTICES.md) for more information.
