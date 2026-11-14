# Typed Celestial HTML Observer (TyCHO)

[![PyPI version](https://img.shields.io/pypi/v/pytycho)](https://pypi.org/project/pytycho/) [![npm version](https://img.shields.io/npm/v/@beeson-group/tycho)](https://www.npmjs.com/package/@beeson-group/tycho) [![Python versions](https://img.shields.io/pypi/pyversions/pytycho)](https://pypi.org/project/pytycho/) [![CI](https://github.com/beeson-group/tycho/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/beeson-group/tycho/actions/workflows/ci.yml) [![Documentation](https://readthedocs.org/projects/pytycho/badge/?version=latest)](https://pytycho.readthedocs.io/) [![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff) [![uv](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/uv/main/assets/badge/v0.json)](https://github.com/astral-sh/uv) [![DOI](https://zenodo.org/badge/1396745013.svg)](https://zenodo.org/badge/latestdoi/1396745013)

TyCHO makes animated, interactive astrodynamics visualizations, each of which is a single HTML file (the page). You open the page with a double click, and it works offline, since the data and the code that draws them are both inside the file. You can also put it on a website, or on a slide of our [slides template](https://github.com/beeson-group/slides). On one page, you can show the same orbits in several reference frames side by side. TyCHO only draws trajectories that another library has computed, and it never integrates an equation of motion itself.

PRE-RELEASE NOTICE: the scene format may still change incompatibly until version 1.0. You can open a live example from our [gallery](https://pytycho.readthedocs.io/en/stable/gallery.html).

![The Broucke families of the elliptic restricted three-body problem, animated in several reference frames side by side](https://github.com/beeson-group/tycho/releases/latest/download/broucke.gif)

The animation above shows the planar Broucke families of the elliptic restricted three-body problem (periodic orbits that Broucke published in 1969) in several reference frames at once.

## Installing and using TyCHO

Install the Python package, pytycho, with the command below.

```sh
pip install pytycho
```

pytycho needs only Python and NumPy (the JavaScript that draws the page is shipped inside the package).

From here, I recommend starting with the [quick start](https://pytycho.readthedocs.io/en/stable/quickstart.html), where you write a first page. In the [guide](https://pytycho.readthedocs.io/en/stable/guide/index.html), each piece of a scene is then explained, and in the [gallery](https://pytycho.readthedocs.io/en/stable/gallery.html) you can open complete examples.

## Using TyCHO with a coding agent

You can also ask your favorite coding agent to build a visualization for you. For this purpose we ship a skill, i.e. a page of instructions from which an agent learns how to write a TyCHO scene and check it. Your agent loads it whenever a task calls for it.

In Claude Code, you add this repository as a plugin marketplace (a source of plugins) and install the skill with the command below.

```sh
claude plugin marketplace add beeson-group/tycho && claude plugin install tycho@beeson-group
```

For Codex, Cursor, Copilot, Gemini CLI, OpenCode, and other agents, you install the same skill with the command below.

```sh
npx skills add beeson-group/tycho
```

## Setting up the repository to contribute

This repository is made of two halves, the Python package pytycho (in `src/`) and the JavaScript that draws the page (the runtime, in `web/`). The steps below set up both on your machine.

1. Install [git](https://git-scm.com/downloads), [Node.js](https://nodejs.org/) version 24 or later (which comes with npm, and builds and tests the runtime), and [uv](https://docs.astral.sh/uv/) (which runs every Python command below, and downloads Python for you if needed).
2. Clone the repository, and move into it.
   ```sh
   git clone https://github.com/beeson-group/tycho.git
   cd tycho
   ```
3. Build the runtime. The built JavaScript is not kept in git, and pytycho cannot write a page without it, hence you run this step first (and again after you change anything in `web/`).
   ```sh
   npm --prefix web ci && npm --prefix web run build
   ```
4. Run the tests of pytycho and of the runtime, respectively. The first run of `uv run` also creates a virtual environment in `.venv`.
   ```sh
   uv run pytest
   npm --prefix web test
   ```
5. Turn on the pre-commit checks, which then check style, types, and spelling every time you commit, and stop the commit if one of them fails.
   ```sh
   uvx pre-commit install
   ```

Before you open a pull request, please read our group's [contributing guide](https://github.com/beeson-group/.github/blob/main/CONTRIBUTING.md), where I explain what I expect of one.

## License

TyCHO is licensed under [Apache-2.0](https://github.com/beeson-group/tycho/blob/main/LICENSE). We also bundle two libraries under the MIT license into every page, three.js (which draws the panels) and mp4-muxer (which writes the video export). See [NOTICE](https://github.com/beeson-group/tycho/blob/main/NOTICE) and [THIRD_PARTY_NOTICES.md](https://github.com/beeson-group/tycho/blob/main/THIRD_PARTY_NOTICES.md) for more information.
