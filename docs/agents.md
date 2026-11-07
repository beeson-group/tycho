# Agents

TyCHO ships a skill for coding agents in the [Agent Skills](https://agentskills.io) format. A skill is a page of instructions that an agent such as Claude Code or Codex reads when a task calls for it. In one page, the skill sets out the scene grammar for an agent, i.e. the pieces from which a scene is declared, such as track sets, frames, and panels. The page covers the minimal scene, how the pieces fit, thinning (keeping a subset of the stored samples of each track), where the channels of a frame come from, and how to check a scene. The agent is instructed to take the channels that a frame reads, e.g. the true anomaly of each sample, from the library that computed the trajectory rather than from a formula in the script. An agent asked to animate an orbit family, or to add a frame, a slider, or a panel, thus produces a scene that writes without an error. The agent is also instructed to read the rule given by a failing check and to fix the scene, rather than work around the check by editing the written document.

## Install

In Claude Code, the repository is a plugin marketplace, i.e. a source of plugins, and the commands below add it and install the skill as a plugin.

```sh
claude plugin marketplace add beeson-group/tycho
claude plugin install tycho@beeson-group
```

For Codex, Cursor, Copilot, Gemini CLI, OpenCode, and other agents, the `skills` command-line tool installs the skill.

```sh
npx skills add beeson-group/tycho
```

## The skill

The skill is shown below as it ships, from [`skills/tycho/SKILL.md`](https://github.com/beeson-group/tycho/blob/main/skills/tycho/SKILL.md).

```{literalinclude} ../skills/tycho/SKILL.md
:language: markdown
```

## llms.txt

Two further files are published on this site for agents and documentation servers that read them. The file [`llms.txt`](site:llms.txt) is an index of the pages of the site, and [`llms-full.txt`](site:llms-full.txt) holds the text of every page in one file.

## Contributing with an agent

The skill serves people who use pytycho. An agent working inside the repository, on pytycho or the runtime, reads `AGENTS.md` at the repository root instead. This file holds the build and test commands and the conventions of the code. Codex, Cursor, Copilot, and Claude Code read it, and only contributors see it.
