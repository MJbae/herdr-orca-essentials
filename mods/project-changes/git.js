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

// Keep credential-bearing destination URLs out of state rendered by the view.
const pushDestinations = new WeakMap();
const pushRead = (exec, root, on, args) => exec("git", ["--no-optional-locks", ...args], { cwd: root, on });
const lines = text => text.trim().split("\n").filter(Boolean);

async function pushConfig(exec, root, on, name, all = false) {
  const result = await pushRead(exec, root, on, ["config", all ? "--get-all" : "--get", name]);
  if (result.code !== 0 && result.code !== 1) throw new Error("Cannot read Git push settings.");
  return result.code === 0 ? result.stdout.trim() : "";
}

function refMatch(pattern, ref) {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === ref ? "" : null;
  if (parts.length !== 2 || !ref.startsWith(parts[0]) || !ref.endsWith(parts[1]) || ref.length < parts[0].length + parts[1].length) return null;
  return ref.slice(parts[0].length, ref.length - parts[1].length);
}

function trackingFor(fetchConfig, target) {
  const source = `refs/heads/${target}`, specs = lines(fetchConfig), matches = new Set();
  if (specs.some(spec => spec.startsWith("^") && refMatch(spec.slice(1), source) !== null)) return null;
  for (const spec of specs) {
    const [from, to] = spec.replace(/^\+/, "").split(":");
    if (!to?.startsWith("refs/remotes/")) continue;
    const part = refMatch(from, source);
    if (part !== null) matches.add(to.replace("*", part));
  }
  return matches.size === 1 ? [...matches][0] : null;
}

export async function readPushState(exec, root, on, selectedRemote = null) {
  const state = { branch: null, head: null, remote: null, target: null, upstream: null,
    publish: false, ahead: null, behind: null, canPush: false, reason: "", remotes: [], selectedRemote };
  const [branch, head, remoteList] = await Promise.all([
    pushRead(exec, root, on, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    pushRead(exec, root, on, ["rev-parse", "--verify", "HEAD^{commit}"]),
    pushRead(exec, root, on, ["remote"]),
  ]);
  if (remoteList.code !== 0) { state.reason = "Not a Git repository."; return state; }
  state.remotes = lines(remoteList.stdout);
  state.branch = branch.code === 0 ? branch.stdout.trim() : null;
  state.head = head.code === 0 ? head.stdout.trim() : null;
  if (!state.branch) { state.reason = "Switch to a branch before pushing."; return state; }
  if (!state.head) { state.reason = "Create a commit before pushing."; return state; }
  if (!state.remotes.length) { state.reason = "Add a Git remote in the terminal first."; return state; }

  const [branchRemote, defaultRemote, upstreamRemote, mergeRefs] = await Promise.all([
    pushConfig(exec, root, on, `branch.${state.branch}.pushRemote`),
    pushConfig(exec, root, on, "remote.pushDefault"),
    pushConfig(exec, root, on, `branch.${state.branch}.remote`),
    pushConfig(exec, root, on, `branch.${state.branch}.merge`, true),
  ]);
  const merges = lines(mergeRefs);
  const upstreamBranch = merges.length === 1 && merges[0].startsWith("refs/heads/") ? merges[0].slice(11) : null;
  state.upstream = upstreamRemote && upstreamBranch ? `${upstreamRemote}/${upstreamBranch}` : null;
  state.publish = !state.upstream;
  state.remote = selectedRemote || branchRemote || defaultRemote || upstreamRemote || (state.remotes.length === 1 ? state.remotes[0] : null);
  if (!state.remote) { state.reason = "Choose a remote to push to."; return state; }
  if (state.remote === ".") { state.reason = "Choose a remote instead of local tracking."; return state; }
  if (!state.remotes.includes(state.remote)) { state.reason = "The selected push remote is not configured."; return state; }
  if (state.remote === upstreamRemote && merges.length && !upstreamBranch) { state.reason = "Choose one upstream branch in the terminal."; return state; }
  state.target = state.remote === upstreamRemote && upstreamBranch ? upstreamBranch : state.branch;
  const validTarget = await pushRead(exec, root, on, ["check-ref-format", `refs/heads/${state.target}`]);
  if (validTarget.code !== 0) { state.reason = "The push branch name is invalid."; return state; }
  const [mirror, destinations, fetchConfig] = await Promise.all([
    pushRead(exec, root, on, ["config", "--bool", "--get", `remote.${state.remote}.mirror`]),
    pushRead(exec, root, on, ["remote", "get-url", "--push", "--all", "--", state.remote]),
    pushConfig(exec, root, on, `remote.${state.remote}.fetch`, true),
  ]);
  if (mirror.code !== 0 && mirror.code !== 1) { state.reason = "Check the remote's mirror setting in the terminal."; return state; }
  if (mirror.stdout.trim() === "true") { state.reason = "Mirror remotes must be pushed from the terminal."; return state; }
  const urls = destinations.code === 0 ? lines(destinations.stdout) : [];
  if (urls.length !== 1) { state.reason = "Configure one push URL for this remote in the terminal."; return state; }

  // Counts describe local tracking refs; they never trigger a background fetch.
  const mappedTracking = trackingFor(fetchConfig, state.target);
  let tracking = mappedTracking || `refs/remotes/${state.remote}/${state.target}`;
  if (state.remote === upstreamRemote && upstreamBranch) {
    const ref = await pushRead(exec, root, on, ["rev-parse", "--symbolic-full-name", "--verify", "@{upstream}"]);
    if (ref.code === 0) tracking = ref.stdout.trim();
  }
  const [counts, tracked] = await Promise.all([
    pushRead(exec, root, on, ["rev-list", "--left-right", "--count", `${state.head}...${tracking}`, "--"]),
    mappedTracking ? pushRead(exec, root, on, ["rev-parse", "--verify", `${mappedTracking}^{commit}`]) : Promise.resolve({ code: 1, stdout: "" }),
  ]);
  const match = counts.code === 0 ? /^(\d+)\s+(\d+)\s*$/.exec(counts.stdout) : null;
  if (match) { state.ahead = Number(match[1]); state.behind = Number(match[2]); }
  state.canPush = true;
  state.reason = state.publish ? "Push this branch and set its upstream." : "Push committed changes to this branch.";
  pushDestinations.set(state, { root, on: on ?? null, url: urls[0], tracking: mappedTracking, trackedHead: tracked.code === 0 ? tracked.stdout.trim() : null });
  return state;
}

function pushFailure(text) {
  if (/authentication|permission denied|could not read username|access denied|repository not found/i.test(text)) return "Push failed. Check your Git sign-in and repository access in the terminal.";
  if (/hook declined|remote rejected|pre-push/i.test(text)) return "Push rejected. Check repository hooks or remote rules in the terminal.";
  if (/non-fast-forward|fetch first/i.test(text)) return "Push rejected. Fetch and merge or rebase incoming commits in the terminal, then try again.";
  return "Push failed. Check the remote and your connection in the terminal.";
}

export async function pushBranch(exec, root, on, expected) {
  const destination = pushDestinations.get(expected);
  if (!expected?.canPush || !destination || destination.root !== root || destination.on !== (on ?? null)) throw new Error("Refresh the push target and try again.");
  const current = await readPushState(exec, root, on, expected.selectedRemote);
  const nextDestination = pushDestinations.get(current);
  if (!current.canPush || ["branch", "head", "remote", "target", "upstream", "publish"].some(name => current[name] !== expected[name]) || nextDestination?.url !== destination.url) {
    throw new Error("The branch or push target changed. Review it and try again.");
  }
  let response;
  try {
    // Explicit SHA + branch ref sends only the reviewed commit, even if checkout
    // changes while Git is connecting. Ref defaults, tags and submodule pushes
    // cannot widen this operation; ordinary hooks and server rules still apply.
    response = await exec("git", ["push", "--porcelain", "--no-force", "--no-mirror", "--no-follow-tags", "--recurse-submodules=no", "--", destination.url, `${expected.head}:refs/heads/${expected.target}`], { cwd: root, on, timeout: 120000 });
  } catch {
    throw new Error("Push did not finish. Check the remote in the terminal before trying again.");
  }
  if (response.code !== 0) throw new Error(pushFailure(`${response.stderr}\n${response.stdout}`));
  let message = `Pushed to ${expected.remote}/${expected.target}.`;
  try {
    // The transport is pinned to its reviewed URL. Update local tracking only
    // while that named remote and checkout still mean the same thing.
    const after = await readPushState(exec, root, on, expected.selectedRemote);
    const afterDestination = pushDestinations.get(after);
    if (!after.canPush || ["branch", "head", "remote", "target", "upstream"].some(name => after[name] !== expected[name]) || afterDestination?.url !== destination.url || afterDestination?.tracking !== nextDestination.tracking) {
      message += " Local changes made during the push were kept.";
    } else {
      if (nextDestination.tracking) {
        const tracked = await exec("git", ["update-ref", "--no-deref", nextDestination.tracking, expected.head, nextDestination.trackedHead || "0".repeat(expected.head.length)], { cwd: root, on });
        if (tracked.code !== 0 && afterDestination.trackedHead !== expected.head) message += " Refresh branch tracking in the terminal.";
      }
      if (expected.publish) {
        const configured = await exec("git", ["branch", `--set-upstream-to=${nextDestination.tracking || `${expected.remote}/${expected.target}`}`, "--", expected.branch], { cwd: root, on });
        if (configured.code !== 0) message += " Set branch tracking in the terminal.";
      }
    }
  } catch { message += " Refresh branch tracking in the terminal."; }
  return { message, remote: expected.remote, target: expected.target };
}
