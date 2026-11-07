#!/usr/bin/env -S uv run --script

# /// script
# dependencies = ["nox>=2025.10.16"]
# ///

"""Nox sessions. A bare ``nox`` runs lint and tests, and ``nox -s docs`` and ``nox -s build`` run the other two."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import nox

DIR = Path(__file__).parent.resolve()
PROJECT = nox.project.load_toml()
RUNTIME = DIR / "src" / "pytycho" / "_static" / "tycho.js"

nox.needs_version = ">=2025.10.16"
nox.options.default_venv_backend = "uv|virtualenv"


@nox.session
def lint(session: nox.Session) -> None:
    """Run the pre-commit hooks over every file."""
    session.install("pre-commit")
    session.run("pre-commit", "run", "--all-files", "--show-diff-on-failure", *session.posargs)


@nox.session
def tests(session: nox.Session) -> None:
    """Run the Python tests."""
    test_deps = nox.project.dependency_groups(PROJECT, "test")
    session.install("-e.", *test_deps)
    session.run("pytest", *session.posargs)


@nox.session(python="3.14", reuse_venv=True, default=False)
def docs(session: nox.Session) -> None:
    """Build the docs into docs/_build/html, or serve them with --serve. Another builder is chosen with -b."""
    parser = argparse.ArgumentParser()
    parser.add_argument("-b", dest="builder", default="html", help="Build target (default: html)")
    parser.add_argument("--serve", action="store_true", help="Serve and rebuild on change")
    args, posargs = parser.parse_known_args(session.posargs)

    session.install("-e.", "-r", "docs/requirements.txt", *(["sphinx-autobuild"] if args.serve else []))
    shared_args = ("-W", "--keep-going", "-T", f"-b={args.builder}", "docs", f"docs/_build/{args.builder}", *posargs)
    if args.serve:
        session.run("sphinx-autobuild", "--open-browser", *shared_args)
    else:
        session.run("sphinx-build", *shared_args)


@nox.session(default=False)
def build(session: nox.Session) -> None:
    """Build the runtime if it is missing, then the sdist and the wheel into dist/."""
    if not RUNTIME.is_file():
        session.run("npm", "--prefix", "web", "ci", external=True)
        session.run("npm", "--prefix", "web", "run", "build", external=True)
    shutil.rmtree(DIR / "build", ignore_errors=True)
    session.install("build")
    session.run("python", "-m", "build")


if __name__ == "__main__":
    nox.main()
