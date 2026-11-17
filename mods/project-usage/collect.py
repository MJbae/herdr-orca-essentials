#!/usr/bin/env python3
"""Read provider quotas without starting a model turn or exposing account data."""

import argparse
import datetime
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import tempfile
import time


MAX_OUTPUT = 512 * 1024
MIN_AGY_VERSION = (1, 1, 11)
# A minimum version alone does not guarantee that /usage is a read-only command.
# Keep probes disabled until a specific release has been positively verified.
VERIFIED_AGY_VERSIONS = frozenset()


class UsageError(Exception):
    """An intentionally generic, non-public subprocess/protocol failure."""


class UnsupportedUsage(UsageError):
    """The CLI appears to have treated /usage as a conversation."""


def result(provider, status, message=None, source=None):
    value = {"provider": provider, "status": status, "windows": [], "updated_at": None}
    if message:
        value["message"] = message
    if source:
        value["source"] = source
    return value


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def percent(value):
    value = number(value)
    return round(value, 2) if value is not None and 0 <= value <= 100 else None


def timestamp(value):
    value = number(value)
    return int(value) if value is not None and 0 < value < 253402300800 else None


def reset_time(value):
    if not isinstance(value, str):
        return timestamp(value)
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return timestamp(parsed.timestamp()) if parsed.tzinfo else None
    except (ValueError, OverflowError, OSError):
        return None


def display_name(value, fallback):
    # Only documented model/bucket names are accepted; never return raw errors or IDs.
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9 ._()+-]{0,63}", value):
        return value
    return fallback


def window_label(minutes, fallback):
    minutes = number(minutes)
    if minutes is None or minutes <= 0:
        return fallback
    if minutes == 10080:
        return "Weekly"
    if minutes == 300:
        return "5h"
    if minutes % 1440 == 0:
        return "{}d".format(int(minutes / 1440))
    if minutes % 60 == 0:
        return "{}h".format(int(minutes / 60))
    return "{}m".format(int(minutes))


def credits_snapshot(value):
    if not isinstance(value, dict):
        return None
    if not isinstance(value.get("hasCredits"), bool) or not isinstance(value.get("unlimited"), bool):
        return None
    balance = value.get("balance")
    # Credits are provider units, not dollars or token counts. Preserve decimal text.
    if not isinstance(balance, str) or not re.fullmatch(r"[0-9]{1,20}(?:\.[0-9]{1,12})?", balance):
        balance = None
    return {"balance": balance, "unlimited": value["unlimited"], "has_credits": value["hasCredits"]}


def parse_codex(payload, now=None):
    if not isinstance(payload, dict):
        raise UsageError()
    value = result("codex", "ok", source="Codex account API")
    snapshots = []
    legacy = payload.get("rateLimits")
    if isinstance(legacy, dict):
        snapshots.append((legacy.get("limitId") or "codex", legacy))
    multiple = payload.get("rateLimitsByLimitId")
    if isinstance(multiple, dict):
        snapshots.extend((key, snapshot) for key, snapshot in sorted(multiple.items())
                         if isinstance(snapshot, dict))
    seen = set()
    for index, (key, snapshot) in enumerate(snapshots):
        if "credits" not in value:
            credits = credits_snapshot(snapshot.get("credits"))
            if credits is not None:
                value["credits"] = credits
        group = "" if key == "codex" else display_name(snapshot.get("limitName"), "Limit {}".format(index + 1))
        for slot in ("primary", "secondary"):
            window = snapshot.get(slot)
            if not isinstance(window, dict):
                continue
            used = percent(window.get("usedPercent"))
            if used is None:
                continue
            duration = number(window.get("windowDurationMins"))
            reset = timestamp(window.get("resetsAt"))
            identity = (key, duration, used, reset, slot if duration is None else None)
            if identity in seen:
                continue
            seen.add(identity)
            label = window_label(duration, slot.title())
            value["windows"].append({
                "id": "codex-{}-{}".format(index, slot),
                "label": "{} · {}".format(group, label) if group else label,
                "used_percent": used,
                "reset_at": reset,
            })
    if not value["windows"] and "credits" not in value:
        return result("codex", "unavailable", "No quota data is available for this account.", value["source"])
    value["updated_at"] = int(time.time() if now is None else now)
    return value


def parse_agy_version(text):
    # Fail closed for prereleases and ambiguous version output.
    match = re.fullmatch(r"\s*(?:(?:agy|Antigravity(?: CLI)?)\s*(?:version\s*)?)?v?(\d+)\.(\d+)\.(\d+)(?:\+[A-Za-z0-9.-]+)?\s*", text, re.I)
    return tuple(int(part) for part in match.groups()) if match else None


def antigravity_guard_path():
    configured = os.environ.get("XDG_CACHE_HOME", "")
    base = Path(configured) if configured and Path(configured).is_absolute() else Path.home() / ".cache"
    return base / "orca-essentials" / "antigravity-usage-guard.json"


def antigravity_version_blocked(version):
    try:
        with antigravity_guard_path().open("r", encoding="utf-8") as stream:
            value = json.loads(stream.read(4096))
        return isinstance(value, dict) and value.get("blocked") is True and value.get("version") == list(version)
    except (OSError, ValueError):
        return False


def block_antigravity_version(version):
    # Do not repeat a prompt-like command on subsequent polls or application reloads.
    # This cache contains only a CLI version, never the response or any account data.
    path = antigravity_guard_path()
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile("w", dir=str(path.parent), encoding="utf-8", delete=False) as stream:
            temporary = stream.name
            json.dump({"version": list(version), "blocked": True}, stream)
        os.replace(temporary, path)
        return True
    except OSError:
        return False
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def clear_antigravity_version(version):
    if antigravity_version_blocked(version):
        try:
            antigravity_guard_path().unlink()
        except OSError:
            pass


def prompt_payload(value):
    if isinstance(value, dict):
        if "conversation_id" in value:
            return True
        turns = value.get("num_turns")
        if turns is not None and (number(turns) is None or turns > 0):
            return True
        return any(prompt_payload(item) for item in value.values())
    return isinstance(value, list) and any(prompt_payload(item) for item in value)


def parse_antigravity(text, now=None):
    records = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except (ValueError, RecursionError):
            raise UsageError() from None
        if prompt_payload(record):
            raise UnsupportedUsage()
        records.append(record)
    value = result("antigravity", "ok", source="Antigravity /usage")
    found_usage = False
    seen = set()
    for record in records:
        if not isinstance(record, dict) or record.get("status") != "SUCCESS":
            continue
        command = record.get("command")
        if not isinstance(command, dict) or command.get("name") != "usage":
            continue
        found_usage = True
        data = command.get("data")
        groups = data.get("groups") if isinstance(data, dict) else None
        if not isinstance(groups, list):
            raise UsageError()
        name_groups = {}
        for group_index, group in enumerate(groups):
            if isinstance(group, dict) and isinstance(group.get("buckets"), list):
                for bucket in group["buckets"]:
                    if isinstance(bucket, dict) and isinstance(bucket.get("name"), str):
                        name_groups.setdefault(bucket["name"], set()).add(group_index)
        for group_index, group in enumerate(groups):
            if not isinstance(group, dict) or not isinstance(group.get("buckets"), list):
                raise UsageError()
            for bucket_index, bucket in enumerate(group["buckets"]):
                if not isinstance(bucket, dict) or bucket.get("disabled"):
                    continue
                remaining = number(bucket.get("remaining_fraction"))
                if remaining is None or not 0 <= remaining <= 1:
                    continue
                name = display_name(bucket.get("name"), "Quota {}".format(bucket_index + 1))
                group_name = display_name(group.get("name"), "")
                if len(name_groups.get(bucket.get("name"), ())) > 1 and not group_name:
                    group_name = "Group {}".format(group_index + 1)
                if group_name and group_name.casefold() not in name.casefold():
                    name = "{} · {}".format(group_name, name)
                label = {"5h": "5h", "weekly": "Weekly"}.get(bucket.get("window"), "")
                reset = reset_time(bucket.get("reset_time"))
                identity = (group_index, bucket.get("id") if isinstance(bucket.get("id"), str) else bucket_index, label)
                if identity in seen:
                    continue
                seen.add(identity)
                value["windows"].append({
                    "id": "antigravity-{}-{}-{}".format(group_index, bucket_index, label.lower()),
                    "label": "{} · {}".format(name, label) if label else name,
                    "used_percent": percent((1 - remaining) * 100),
                    "reset_at": reset,
                })
    if not found_usage:
        raise UsageError()
    if not value["windows"]:
        return result("antigravity", "unavailable", "No quota data is available for this account.", value["source"])
    value["updated_at"] = int(time.time() if now is None else now)
    return value


class BoundedProcess:
    """Own one CLI process group, bound output/time, and always reap it."""

    def __init__(self, argv, deadline, env=None):
        self.deadline = deadline
        self.buffer = b""
        self.total = 0
        self.eof = False
        self.selector = selectors.DefaultSelector()
        self.process = None
        try:
            self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL, env=env, start_new_session=True)
            self.selector.register(self.process.stdout, selectors.EVENT_READ)
        except (OSError, ValueError):
            self.close()
            raise UsageError() from None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def close(self):
        process = self.process
        if process is not None:
            # Only signal the new group created by this collector, never a shared daemon.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=0.4)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=0.4)
            for stream in (process.stdin, process.stdout):
                if stream is not None:
                    stream.close()
        self.selector.close()

    def send(self, value):
        try:
            self.process.stdin.write((json.dumps(value) + "\n").encode("utf-8"))
            self.process.stdin.flush()
        except (BrokenPipeError, OSError):
            raise UsageError() from None

    def read_line(self):
        while b"\n" not in self.buffer and not self.eof:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0 or not self.selector.select(remaining):
                raise UsageError()
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                self.eof = True
                break
            self.total += len(chunk)
            if self.total > MAX_OUTPUT:
                raise UsageError()
            self.buffer += chunk
        if not self.buffer:
            return None
        line, separator, rest = self.buffer.partition(b"\n")
        self.buffer = rest if separator else b""
        try:
            return line.decode("utf-8")
        except UnicodeDecodeError:
            raise UsageError() from None

    def read_all(self):
        lines = []
        while True:
            line = self.read_line()
            if line is None:
                break
            lines.append(line)
        try:
            code = self.process.wait(timeout=max(0.01, self.deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise UsageError() from None
        if code:
            raise UsageError()
        return "\n".join(lines)

    def rpc(self, request_id, method, params):
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            line = self.read_line()
            if line is None:
                raise UsageError()
            try:
                response = json.loads(line)
            except (ValueError, RecursionError):
                raise UsageError() from None
            if isinstance(response, dict) and response.get("id") == request_id:
                if "error" in response or "result" not in response:
                    raise UsageError()
                return response["result"]


def collect_codex():
    executable = shutil.which("codex")
    if executable is None:
        return result("codex", "unavailable", "Codex CLI is not installed.")
    try:
        with BoundedProcess([executable, "--no-daemon", "app-server", "--stdio"], time.monotonic() + 25) as process:
            process.rpc(1, "initialize", {"clientInfo": {"name": "orca_essentials_usage", "version": "1.0.0"}})
            process.send({"method": "initialized", "params": {}})
            account_result = process.rpc(2, "account/read", {"refreshToken": False})
            account = account_result.get("account") if isinstance(account_result, dict) else None
            if not isinstance(account, dict):
                return result("codex", "unavailable", "Sign in to Codex with your ChatGPT account.")
            if account.get("type") != "chatgpt":
                return result("codex", "unavailable", "Quota is available for ChatGPT sign-in only.")
            return parse_codex(process.rpc(3, "account/rateLimits/read", {"excludeResetCreditDetails": True}))
    except (UsageError, OSError, ValueError, subprocess.SubprocessError):
        return result("codex", "error", "Could not read Codex usage. Check your CLI sign-in and retry.")


def collect_antigravity():
    executable = shutil.which("agy")
    if executable is None:
        return result("antigravity", "unavailable", "Antigravity CLI is not installed.")
    if not VERIFIED_AGY_VERSIONS:
        return result("antigravity", "unavailable", "Usage is not supported by this Antigravity CLI.")
    env = dict(os.environ, AGY_CLI_DISABLE_AUTO_UPDATE="true")
    deadline = time.monotonic() + 27
    try:
        with BoundedProcess([executable, "--version"], min(deadline, time.monotonic() + 4), env) as process:
            version = parse_agy_version(process.read_all())
        if version is None or version < MIN_AGY_VERSION:
            return result("antigravity", "setup", "Usage is not supported by this Antigravity CLI.")
        if version not in VERIFIED_AGY_VERSIONS:
            return result("antigravity", "unavailable", "Usage is not supported by this Antigravity CLI.")
        if antigravity_version_blocked(version):
            return result("antigravity", "setup", "Usage is not supported by this Antigravity CLI.")
        # Persist before the command: even a timeout, malformed output or nonzero exit
        # may conceal a conversation. Only an accepted usage payload clears this.
        if not block_antigravity_version(version):
            return result("antigravity", "setup", "Could not save the usage safety check. Check cache permissions.")
        with BoundedProcess([executable, "-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], deadline, env) as process:
            value = parse_antigravity(process.read_all())
        clear_antigravity_version(version)
        return value
    except UnsupportedUsage:
        return result("antigravity", "setup", "Usage is not supported by this Antigravity CLI.")
    except (UsageError, OSError, ValueError, subprocess.SubprocessError):
        return result("antigravity", "error", "Could not read Antigravity usage. Check your CLI sign-in and retry.")


def collect_claude():
    try:
        from claude_usage import read_usage
        return read_usage()
    except ImportError:
        return result("claude", "setup", "Connect the Claude status line to show usage.")
    except (OSError, ValueError):
        return result("claude", "error", "Could not read the Claude usage cache.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", required=True, choices=("codex", "antigravity", "claude"))
    args = parser.parse_args()
    collectors = {"codex": collect_codex, "antigravity": collect_antigravity, "claude": collect_claude}
    try:
        value = collectors[args.provider]()
    except Exception:
        # Unexpected CLI/schema changes must not print a traceback containing private data.
        value = result(args.provider, "error", "Usage is temporarily unavailable.")
    print(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
