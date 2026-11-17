// Git operations are shared by the native view and isolated repository checks.
export function parseStatus(text) {
  const entries = text.split("\0").filter(Boolean).map(entry => {
    const xy = entry.slice(0, 2), path = entry.slice(3);
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const fresh = xy === "??";
    return { xy, path, fresh, conflict,
      staged: !fresh && !conflict && xy[0] !== " " && xy[0] !== "!",
      unstaged: fresh || conflict || xy[1] !== " " };
  });
  return { entries, total: entries.length,
    staged: entries.filter(entry => entry.staged).length,
    unstaged: entries.filter(entry => entry.unstaged).length,
    conflicts: entries.filter(entry => entry.conflict).length };
}

async function git(exec, root, on, args) {
  const result = await exec("git", args, { cwd: root, on });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Git command failed.").trim());
  return result;
}

async function status(exec, root, on) {
  const result = await git(exec, root, on, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  return parseStatus(result.stdout);
}

export async function stageAll(exec, root, on) {
  const state = await status(exec, root, on);
  if (state.conflicts) throw new Error("Resolve conflicts before staging.");
  await git(exec, root, on, ["add", "-A"]);
}

export async function stageFile(exec, root, on, path) {
  const state = await status(exec, root, on);
  const file = state.entries.find(entry => entry.path === path);
  if (!file || !file.unstaged) return;
  if (file.conflict) throw new Error("Resolve conflicts in this file first.");
  await git(exec, root, on, ["--literal-pathspecs", "add", "-A", "--", path]);
}

export async function unstageFile(exec, root, on, path) {
  const state = await status(exec, root, on);
  const file = state.entries.find(entry => entry.path === path);
  if (file?.conflict) throw new Error("Resolve conflicts in this file first.");
  if (!file?.staged) return;
  const head = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, on });
  // Both commands change only the index. The first commit has no HEAD to restore.
  const args = head.code === 0
    ? ["--literal-pathspecs", "restore", "--staged", "--", path]
    : ["--literal-pathspecs", "rm", "--cached", "-f", "--", path];
  await git(exec, root, on, args);
}

export async function commitStaged(exec, root, on, message) {
  if (!message.trim()) throw new Error("Enter a commit message.");
  const state = await status(exec, root, on);
  if (state.conflicts) throw new Error("Resolve conflicts before committing.");
  if (!state.staged) throw new Error("Stage changes first.");
  return git(exec, root, on, ["commit", "-m", message.trim()]);
}
