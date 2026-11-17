# Orca Essentials

**The essentials of Orca, in Herdr.**

A minimal Orca-inspired workspace built around three everyday tasks: switching projects, browsing files, and committing changes. Your terminal stays at the center, with short English labels and familiar icons around it.

![Orca Essentials](preview.png)

- **Projects** — open a folder, switch between projects, and keep each project's terminals together. Opening the same folder returns to the existing project.
- **Files** — browse the project tree and preview files in the right panel.
- **Changes** — review diffs, **Stage All**, **Stage** or **Unstage** a file, then enter a message and **Commit**. Unstage keeps your edits; Commit includes staged changes only.
- **Usage** — see account limits, used and remaining percentages, reset times, and available Codex credits. Accounts are shared across projects; these are not separate balances for each agent.

## Install

Paste this into your agent in Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/MJbae/herdr-orca-essentials
```

Use **Open Project** or **⌘O** to begin. Switch the right panel with **Files**, **Changes**, and **Usage**. Press Enter in the commit message field to commit.

Tested with **Herdr 0.1.16 on macOS**. Requires Git; other platforms are untested. File previews are read-only. The layout runs local file-listing and Git commands, with no built-in push action.

## Usage setup

[Preview the Usage panel with sample data](usage.png).

Requires Python 3 and the signed-in CLI on this computer: **Codex** with a ChatGPT account or **Claude Code**. For Claude, click **Set Up Claude** to connect its status line, then send a message in Claude. Any existing status-line command is preserved.

Antigravity currently shows **Unavailable**. Its installed CLI did not return a supported usage response; unverified versions are never queried for usage.

Usage refreshes every five minutes while visible, or with **Refresh**. Missing or old data is marked explicitly. Credits keep their provider's units; remaining tokens are not estimated. Remote projects still show this computer's accounts.

Community layout inspired by Orca, adapted from [Herdr](https://github.com/herdrdev/herdr-app)'s Apache-2.0 layout and mods. See [RECIPE.md](RECIPE.md) for the build brief and [LICENSE](LICENSE) for the license.
