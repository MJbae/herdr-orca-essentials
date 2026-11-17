#!/usr/bin/env python3
"""Read Claude's optional status-line quota feed without polling its account API.

Run --install explicitly to wrap the user's existing statusLine command. Claude
then invokes --statusline; only percentages and reset times enter the local cache.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time


MAX_INPUT = 1024 * 1024
STALE_AFTER = 15 * 60
WINDOWS = (("five_hour", "5h"), ("seven_day", "Weekly"))


def _settings_path():
    return Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) / "settings.json"


def _cache_path():
    base = os.environ.get("XDG_CACHE_HOME")
    directory = Path(base) if base and Path(base).is_absolute() else Path.home() / ".cache"
    # Separate explicit Claude profiles without storing their paths or accounts.
    profile = str(_settings_path().parent.expanduser().resolve()).encode("utf-8")
    suffix = hashlib.sha256(profile).hexdigest()[:12]
    return directory / "herdr-orca-essentials" / ("claude-usage-" + suffix + ".json")


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _percentage(value):
    return float(value) if _number(value) and 0 <= value <= 100 else None


def _reset(value):
    return int(value) if _number(value) and 0 < value < 10**12 else None


def sanitize_feed(payload, now=None):
    """Accept only documented quota fields, never session/context/account data."""
    now = time.time() if now is None else now
    rates = payload.get("rate_limits") if isinstance(payload, dict) else None
    windows = []
    for key, label in WINDOWS:
        window = rates.get(key) if isinstance(rates, dict) else None
        if not isinstance(window, dict):
            continue
        used = _percentage(window.get("used_percentage"))
        if used is None:
            continue
        windows.append({"id": key, "label": label, "used_percent": used,
                        "reset_at": _reset(window.get("resets_at"))})
    return {"updated_at": int(now), "windows": windows}


def _atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + "-", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def _load_settings():
    path = _settings_path()
    if path.is_symlink():
        raise ValueError("symlink")
    original = path.read_bytes() if path.exists() else None
    if original is not None and len(original) > MAX_INPUT:
        raise ValueError("oversized settings")
    settings = json.loads(original) if original is not None else {}
    if not isinstance(settings, dict):
        raise ValueError("invalid settings")
    return settings, original


def _wrapper_forward(command):
    """Recognize only this wrapper, including a relocated installed copy."""
    if not isinstance(command, str):
        return False, None
    try:
        words = shlex.split(command)
    except ValueError:
        return False, None
    if len(words) < 3 or Path(words[1]).name != "claude_usage.py" or words[2] != "--statusline":
        return False, None
    if len(words) == 3:
        return True, None
    if len(words) == 4 and words[3].startswith("--forward="):
        return True, words[3][len("--forward="):]
    return False, None


def _installed():
    try:
        settings, _ = _load_settings()
        status_line = settings.get("statusLine")
        return isinstance(status_line, dict) and status_line.get("type") == "command" and _wrapper_forward(status_line.get("command"))[0]
    except (OSError, ValueError, TypeError):
        return False


def _claude_available():
    candidates = (Path.home() / ".local/bin/claude", Path.home() / ".claude/local/claude")
    return bool(shutil.which("claude")) or any(path.is_file() and os.access(path, os.X_OK) for path in candidates)


def _result(status, message=None, installed=False, **extra):
    value = {"provider": "claude", "status": status, "windows": [], "updated_at": None,
             "source": "statusline", "installed": installed}
    if message:
        value["message"] = message
    value.update(extra)
    return value


def read_usage():
    installed = _installed()
    if not installed:
        if not _claude_available():
            return _result("unavailable", "Install Claude Code to connect usage.")
        return _result("setup", "Connect Claude usage with Set Up.")
    try:
        path = _cache_path()
        if path.stat().st_size > MAX_INPUT:
            raise ValueError("oversized cache")
        value = json.loads(path.read_bytes())
        if not isinstance(value, dict):
            raise ValueError("invalid cache")
        updated = value.get("updated_at")
        now = time.time()
        if not _number(updated) or updated <= 0 or updated > now + 60:
            raise ValueError("invalid timestamp")
        # Re-sanitize the cache; unknown labels/fields must never reach the UI.
        raw_windows = value.get("windows")
        raw_windows = raw_windows if isinstance(raw_windows, list) else []
        rates = {}
        for window in raw_windows:
            if isinstance(window, dict) and window.get("id") in dict(WINDOWS):
                rates[window["id"]] = {"used_percentage": window.get("used_percent"),
                                       "resets_at": window.get("reset_at")}
        sanitized = sanitize_feed({"rate_limits": rates}, updated)
        windows = [window for window in sanitized["windows"]
                   if window["reset_at"] is None or window["reset_at"] > now]
        stale = now - updated > STALE_AFTER or len(windows) != len(sanitized["windows"])
        if not windows:
            return _result("unavailable", "Waiting for fresh Claude usage. Run a Claude turn.",
                           installed=True, updated_at=int(updated), stale=True)
        return _result("ok", installed=True, windows=windows, updated_at=int(updated), stale=stale)
    except FileNotFoundError:
        return _result("setup", "Connected. Usage appears after a Claude response.", installed=True)
    except (OSError, ValueError, TypeError):
        return _result("unavailable", "Waiting for a fresh Claude usage report.", installed=True)


def install():
    """Opt-in, idempotent settings change; preserve and forward an existing line."""
    if not _claude_available() and not _installed():
        return _result("unavailable", "Install Claude Code to connect usage.")
    try:
        settings, original = _load_settings()
        status_line = settings.get("statusLine")
        if status_line is not None and (not isinstance(status_line, dict) or
                status_line.get("type") != "command" or not isinstance(status_line.get("command"), str)):
            return _result("error", "Claude status line settings need manual setup.")
        previous = status_line.get("command") if status_line else None
        wrapped, forwarded = _wrapper_forward(previous)
        if wrapped:
            previous = forwarded
        command = [sys.executable, str(Path(__file__).resolve()), "--statusline"]
        if previous:
            command.append("--forward=" + previous)
        next_line = dict(status_line or {})
        next_line.update({"type": "command", "command": " ".join(shlex.quote(word) for word in command)})
        if status_line == next_line:
            return read_usage()
        settings["statusLine"] = next_line
        path = _settings_path()
        current = path.read_bytes() if path.exists() else None
        if current != original:
            return _result("error", "Claude settings changed. Try Set Up again.")
        if original is not None:
            # The private backup remains beside the user's settings, never in the layout.
            descriptor, backup = tempfile.mkstemp(prefix="settings.json.herdr-usage-backup-", dir=str(path.parent))
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(original)
                stream.flush()
                os.fsync(stream.fileno())
        _atomic_write(path, _json_bytes(settings))
        return read_usage()
    except (OSError, ValueError, TypeError):
        return _result("error", "Claude settings could not be updated.")


def statusline(forward=None):
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        return 0
    try:
        data = sanitize_feed(json.loads(raw))
        _atomic_write(_cache_path(), _json_bytes(data))
    except (OSError, ValueError, TypeError):
        pass  # A cache failure must not break an existing status line.
    if not forward:
        return 0
    process = None
    try:
        process = subprocess.Popen(forward, shell=True, stdin=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        process.communicate(raw, timeout=5)
        return process.returncode
    except (OSError, subprocess.TimeoutExpired):
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--install", action="store_true")
    action.add_argument("--statusline", action="store_true")
    parser.add_argument("--forward")
    args = parser.parse_args()
    if args.statusline:
        return statusline(args.forward)
    value = install() if args.install else read_usage()
    print(json.dumps(value, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
