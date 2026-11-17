# Orca Essentials

**The essentials of Orca, in Herdr.**

A minimal Orca-inspired workspace built around three everyday tasks: switching projects, browsing files, and committing changes. Your terminal stays at the center, with short English labels and familiar icons around it.

![Orca Essentials](preview.png)

- **Projects** — open a folder, switch between projects, and keep each project's terminals together. Opening the same folder returns to the existing project.
- **Files** — browse the project tree and preview files in the right panel.
- **Changes** — review diffs, **Stage All**, **Stage** or **Unstage** a file, then enter a message and **Commit**. Unstage keeps your edits; Commit includes staged changes only.

## Install

Paste this into your agent in Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/MJbae/herdr-orca-essentials
```

Use **Open Project** or **⌘O** to begin. Switch the right panel with **Files** and **Changes**. Press Enter in the commit message field to commit.

Tested with **Herdr 0.1.16 on macOS**. Requires Git; other platforms are untested. File previews are read-only. The layout runs local file-listing and Git commands, with no built-in push action.

Community layout inspired by Orca, adapted from [Herdr](https://github.com/herdrdev/herdr-app)'s Apache-2.0 layout and mods. See [RECIPE.md](RECIPE.md) for the build brief and [LICENSE](LICENSE) for the license.
