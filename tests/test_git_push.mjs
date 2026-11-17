import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../mods/project-changes/git.js"), "utf8");
const { readPushState, pushBranch, stageAll, unstageFile, commitStaged } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const io = async (command, args, options) => {
  const result = spawnSync(command, args, { cwd: options.cwd, env, encoding: "utf8", timeout: 10000 });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
async function git(cwd, ...args) {
  const result = await io("git", args, { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t, name = "work") {
  const directory = await mkdtemp(join(tmpdir(), "orca-push-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, name), remote = join(directory, "server.git");
  await git(directory, "init", "--quiet", "--initial-branch=main", root);
  await git(directory, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  for (const [key, value] of [["user.name", "UI Test"], ["user.email", "ui@example.invalid"], ["commit.gpgSign", "false"], ["core.hooksPath", "/dev/null"]]) await git(root, "config", key, value);
  return { directory, root, remote };
}
async function commit(root, text = "first") {
  await writeFile(join(root, "file.txt"), text + "\n");
  await stageAll(io, root, null);
  await commitStaged(io, root, null, text);
  return git(root, "rev-parse", "HEAD");
}
async function origin(root, remote) { await git(root, "remote", "add", "origin", remote); }

test("stage, unstage, commit and publish preserve excluded edits", async t => {
  const { root, remote } = await fixture(t);
  await origin(root, remote);
  await writeFile(join(root, "include.txt"), "publish\n");
  await writeFile(join(root, "leave.txt"), "keep local\n");
  await stageAll(io, root, null);
  await unstageFile(io, root, null, "leave.txt");
  await commitStaged(io, root, null, "Publish selected file");
  const state = await readPushState(io, root, null);
  assert.equal(state.canPush, true);
  assert.equal(state.publish, true);
  assert.equal(state.target, "main");
  assert.equal(state.ahead, null);
  assert.equal(JSON.stringify(state).includes(remote), false, "remote URL stays private");
  const pushed = await pushBranch(io, root, null, state);
  assert.match(pushed.message, /^Pushed to origin\/main/);
  assert.equal(await git(remote, "ls-tree", "--name-only", "main"), "include.txt");
  assert.equal(await readFile(join(root, "leave.txt"), "utf8"), "keep local\n");
  assert.equal(await git(root, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
  const synced = await readPushState(io, root, null);
  assert.equal(synced.ahead, 0); assert.equal(synced.behind, 0);
  assert.equal(synced.canPush, true, "cached refs never prevent a manual push");
});

test("push respects a differently named upstream branch", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote);
  await commit(root); await git(root, "push", "-u", "origin", "main:release");
  const head = await commit(root, "next");
  const state = await readPushState(io, root, null);
  assert.equal(state.target, "release"); assert.equal(state.upstream, "origin/release");
  assert.equal(state.ahead, 1); assert.equal(state.publish, false);
  await pushBranch(io, root, null, state);
  assert.equal(await git(remote, "rev-parse", "release"), head);
  assert.notEqual((await io("git", ["show-ref", "--verify", "refs/heads/main"], { cwd: remote })).code, 0);
});

test("unborn, detached, missing and ambiguous remotes need a clear target", async t => {
  const { root, remote, directory } = await fixture(t);
  assert.match((await readPushState(io, root, null)).reason, /Create a commit/);
  await commit(root);
  assert.match((await readPushState(io, root, null)).reason, /Add a Git remote/);
  await origin(root, remote); await git(root, "remote", "add", "backup", join(directory, "backup.git"));
  const ambiguous = await readPushState(io, root, null);
  assert.equal(ambiguous.canPush, false); assert.match(ambiguous.reason, /Choose a remote/);
  assert.deepEqual(ambiguous.remotes, ["backup", "origin"]);
  assert.equal((await readPushState(io, root, null, "origin")).canPush, true);
  assert.equal((await readPushState(io, root, null, "missing")).canPush, false);
  await git(root, "checkout", "--detach", "--quiet");
  assert.match((await readPushState(io, root, null)).reason, /Switch to a branch/);
});

test("push-remote precedence and explicit choice retain the pull upstream", async t => {
  const { root, remote, directory } = await fixture(t); await origin(root, remote);
  const fork = join(directory, "fork.git");
  await git(directory, "init", "--quiet", "--bare", fork);
  await git(root, "remote", "add", "fork", fork);
  await commit(root); await git(root, "push", "-u", "origin", "main");
  assert.equal((await readPushState(io, root, null)).remote, "origin");
  await git(root, "config", "remote.pushDefault", "fork");
  assert.equal((await readPushState(io, root, null)).remote, "fork");
  await git(root, "config", "branch.main.pushRemote", "origin");
  assert.equal((await readPushState(io, root, null)).remote, "origin");
  const selected = await readPushState(io, root, null, "fork");
  assert.equal(selected.remote, "fork"); assert.equal(selected.publish, false);
  await pushBranch(io, root, null, selected);
  assert.equal(await git(root, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
  assert.equal(await git(fork, "rev-parse", "main"), selected.head);
});

test("local tracking, mirror remotes and multiple push URLs cannot broaden a push", async t => {
  const { root, remote, directory } = await fixture(t); await origin(root, remote); await commit(root);
  await git(root, "config", "branch.main.remote", "."); await git(root, "config", "branch.main.merge", "refs/heads/main");
  assert.equal((await readPushState(io, root, null)).canPush, false);
  assert.equal((await readPushState(io, root, null, "origin")).canPush, true);
  await git(root, "config", "--unset", "branch.main.remote");
  await git(root, "config", "remote.origin.mirror", "true");
  assert.match((await readPushState(io, root, null)).reason, /Mirror/);
  await git(root, "config", "--unset", "remote.origin.mirror");
  await git(root, "config", "--add", "remote.origin.pushurl", remote);
  await git(root, "config", "--add", "remote.origin.pushurl", join(directory, "other.git"));
  assert.match((await readPushState(io, root, null)).reason, /one push URL/);
});

test("one explicit branch is pushed despite matching, tag and refspec defaults", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote);
  const base = await commit(root); await git(root, "branch", "other");
  await git(root, "push", "-u", "origin", "main", "other");
  await git(root, "checkout", "--quiet", "other"); await commit(root, "other changed");
  await git(root, "checkout", "--quiet", "main"); const head = await commit(root, "main changed");
  await git(root, "tag", "-a", "private-tag", "-m", "leave local");
  await git(root, "config", "push.default", "matching");
  await git(root, "config", "push.followTags", "true");
  await git(root, "config", "remote.origin.push", "refs/heads/other:refs/heads/other");
  await pushBranch(io, root, null, await readPushState(io, root, null));
  assert.equal(await git(remote, "rev-parse", "main"), head);
  assert.equal(await git(remote, "rev-parse", "other"), base);
  assert.equal(await git(remote, "tag", "--list"), "");
});

test("changed head or effective destination invalidates a reviewed push", async t => {
  const { root, remote, directory } = await fixture(t); await origin(root, remote); await commit(root);
  const original = await readPushState(io, root, null);
  await commit(root, "newer");
  await assert.rejects(pushBranch(io, root, null, original), /changed/);
  const changed = await readPushState(io, root, null);
  await git(root, "remote", "set-url", "origin", join(directory, "changed.git"));
  await assert.rejects(pushBranch(io, root, null, changed), /changed/);
  assert.notEqual((await io("git", ["show-ref"], { cwd: remote })).code, 0);
});

test("snapshot SHA protects an in-flight push when the checkout changes", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote);
  const reviewed = await commit(root);
  const state = await readPushState(io, root, null);
  let latest;
  const racing = async (command, args, options) => {
    if (args[0] === "push") {
      assert.equal(options.timeout, 120000);
      assert.deepEqual(args.slice(-3), ["--", remote, `${reviewed}:refs/heads/main`]);
      latest = await commit(root, "made while connecting");
    }
    return io(command, args, options);
  };
  const result = await pushBranch(racing, root, null, state);
  assert.equal(await git(remote, "rev-parse", "main"), reviewed);
  assert.equal(await git(root, "rev-parse", "HEAD"), latest);
  assert.match(result.message, /Local changes/);
});

test("a newer remote rejects normally and is never overwritten", async t => {
  const { root, remote, directory } = await fixture(t); await origin(root, remote);
  await commit(root); await pushBranch(io, root, null, await readPushState(io, root, null));
  const clone = join(directory, "colleague");
  await git(directory, "clone", "--quiet", remote, clone);
  await git(clone, "config", "user.name", "Colleague"); await git(clone, "config", "user.email", "colleague@example.invalid");
  await git(clone, "config", "commit.gpgSign", "false"); await git(clone, "config", "core.hooksPath", "/dev/null");
  const colleague = await commit(clone, "colleague"); await git(clone, "push", "origin", "main");
  await commit(root, "local divergence");
  await assert.rejects(pushBranch(io, root, null, await readPushState(io, root, null)), /Fetch and merge or rebase/);
  assert.equal(await git(remote, "rev-parse", "main"), colleague);
  await git(root, "fetch", "--quiet", "origin");
  const state = await readPushState(io, root, null);
  assert.equal(state.ahead, 1); assert.equal(state.behind, 1);
});

test("authentication diagnostics never reveal URL credentials", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote); await commit(root);
  const state = await readPushState(io, root, "machine");
  const failing = async (command, args, options) => {
    assert.equal(options.on, "machine");
    if (args[0] === "push") return { code: 128, stdout: "", stderr: "fatal: Authentication failed for https://user:private-password@example.invalid/repo" };
    return io(command, args, options);
  };
  await assert.rejects(pushBranch(failing, root, "machine", state), error => /sign-in/.test(error.message) && !error.message.includes("private-password"));
});

test("remote rejection hooks still run and are not reported as merge problems", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote); await commit(root);
  await writeFile(join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await assert.rejects(pushBranch(io, root, null, await readPushState(io, root, null)), /hooks or remote rules/);
  assert.notEqual((await io("git", ["show-ref"], { cwd: remote })).code, 0);
});

test("successful pushes remain successful if local tracking cannot be configured", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote); await commit(root);
  const state = await readPushState(io, root, null);
  const failingTracking = async (command, args, options) => {
    if (args[0] === "branch") throw new Error("local write unavailable");
    return io(command, args, options);
  };
  const result = await pushBranch(failingTracking, root, null, state);
  assert.match(result.message, /^Pushed to origin\/main/);
  assert.match(result.message, /branch tracking/);
  assert.equal(await git(remote, "rev-parse", "main"), state.head);
});

test("a remote URL changed during the push cannot redirect the reviewed commit", async t => {
  const { root, remote, directory } = await fixture(t); await origin(root, remote); await commit(root);
  const other = join(directory, "unexpected.git"); await git(directory, "init", "--quiet", "--bare", other);
  const state = await readPushState(io, root, null);
  const redirected = async (command, args, options) => {
    if (args[0] === "push") await git(root, "remote", "set-url", "origin", other);
    return io(command, args, options);
  };
  const result = await pushBranch(redirected, root, null, state);
  assert.equal(await git(remote, "rev-parse", "main"), state.head);
  assert.notEqual((await io("git", ["show-ref"], { cwd: other })).code, 0);
  assert.notEqual((await io("git", ["config", "--get", "branch.main.remote"], { cwd: root })).code, 0);
  assert.match(result.message, /Local changes/);
});

test("configured tracking ref mappings are respected without overwriting local branches", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote); await commit(root);
  await git(root, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/custom/*");
  const state = await readPushState(io, root, null);
  await pushBranch(io, root, null, state);
  assert.equal(await git(root, "rev-parse", "refs/remotes/custom/main"), state.head);
  assert.equal(await git(root, "rev-parse", "--abbrev-ref", "@{upstream}"), "custom/main");
  assert.equal((await readPushState(io, root, null)).ahead, 0);
});

test("concurrent tracking updates survive post-push bookkeeping", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote);
  await commit(root); await pushBranch(io, root, null, await readPushState(io, root, null));
  await commit(root, "next");
  const state = await readPushState(io, root, null);
  const later = await git(root, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "concurrent fetch fixture");
  const concurrent = async (command, args, options) => {
    const response = await io(command, args, options);
    if (args[0] === "push") await git(root, "update-ref", "refs/remotes/origin/main", later);
    return response;
  };
  const result = await pushBranch(concurrent, root, null, state);
  assert.equal(await git(remote, "rev-parse", "main"), state.head);
  assert.equal(await git(root, "rev-parse", "refs/remotes/origin/main"), later);
  assert.match(result.message, /Refresh branch tracking/);
});

test("symbolic remote-tracking refs cannot redirect bookkeeping into a local branch", async t => {
  const { root, remote } = await fixture(t); await origin(root, remote);
  const base = await commit(root); await pushBranch(io, root, null, await readPushState(io, root, null));
  await git(root, "branch", "keep-local", base);
  await git(root, "symbolic-ref", "refs/remotes/origin/main", "refs/heads/keep-local");
  const head = await commit(root, "next");
  await pushBranch(io, root, null, await readPushState(io, root, null));
  assert.equal(await git(remote, "rev-parse", "main"), head);
  assert.equal(await git(root, "rev-parse", "refs/heads/keep-local"), base);
  assert.equal(await git(root, "rev-parse", "refs/remotes/origin/main"), head);
  assert.notEqual((await io("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/main"], { cwd: root })).code, 0);
});
