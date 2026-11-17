"""Hermetic Claude feed and opt-in setup tests; never touch real settings."""

import importlib.util
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


HELPER = Path(__file__).resolve().parents[1] / "mods/project-usage/claude_usage.py"
SPEC = importlib.util.spec_from_file_location("claude_usage", HELPER)
usage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(usage)


class ClaudeUsageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = self.root / "claude config"
        self.cache = self.root / "cache"
        self.environment = patch.dict(os.environ, {
            "HOME": str(self.root), "CLAUDE_CONFIG_DIR": str(self.config),
            "XDG_CACHE_HOME": str(self.cache),
        })
        self.environment.start()
        self.available = patch.object(usage, "_claude_available", return_value=True)
        self.available.start()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.available.stop)

    def write_settings(self, value):
        self.config.mkdir(parents=True, exist_ok=True)
        usage._settings_path().write_text(json.dumps(value), encoding="utf-8")

    def feed(self, value, forward=None):
        command = [sys.executable, str(HELPER), "--statusline"]
        if forward:
            command.append("--forward=" + forward)
        return subprocess.run(command, input=json.dumps(value).encode(),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)

    def cache_value(self, value, updated=None):
        if updated is None:
            updated = int(time.time())
        data = usage.sanitize_feed(value, updated)
        usage._atomic_write(usage._cache_path(), usage._json_bytes(data))

    def test_feed_keeps_only_quota_fields(self):
        result = usage.sanitize_feed({"email": "private@example.invalid", "prompt": "private prompt",
            "context_window": {"used_percentage": 90}, "rate_limits": {
                "five_hour": {"used_percentage": 12.5, "resets_at": 2000000000,
                              "access_token": "private token"},
                "seven_day": {"used_percentage": 42, "resets_at": None},
                "spend_limit": {"used_usd": 10},
            }}, 1800000000)
        self.assertEqual(result, {"updated_at": 1800000000, "windows": [
            {"id": "five_hour", "label": "5h", "used_percent": 12.5, "reset_at": 2000000000},
            {"id": "seven_day", "label": "Weekly", "used_percent": 42.0, "reset_at": None},
        ]})
        self.assertNotIn("private", json.dumps(result))

    def test_bad_percentages_are_missing_not_zero(self):
        for invalid in (None, True, "42", -1, 101, float("nan"), float("inf")):
            with self.subTest(value=invalid):
                result = usage.sanitize_feed({"rate_limits": {
                    "five_hour": {"used_percentage": invalid}}})
                self.assertEqual(result["windows"], [])

    def test_install_preserves_settings_and_forwards_original_stdin_stdout(self):
        previous = " ".join(shlex.quote(word) for word in [sys.executable, "-c",
            "import json,sys; x=json.load(sys.stdin); print('existing:' + x['display'])"])
        settings = {"theme": "dark", "statusLine": {"type": "command", "command": previous, "padding": 2}}
        self.write_settings(settings)
        before = usage._settings_path().read_bytes()
        result = usage.install()
        self.assertTrue(result["installed"])
        after = json.loads(usage._settings_path().read_text())
        self.assertEqual(after["theme"], "dark")
        self.assertEqual(after["statusLine"]["padding"], 2)
        wrapped, forward = usage._wrapper_forward(after["statusLine"]["command"])
        self.assertTrue(wrapped)
        self.assertEqual(forward, previous)
        response = subprocess.run(after["statusLine"]["command"], shell=True,
            input=json.dumps({"display": "same output", "session_id": "private id", "rate_limits": {
                "five_hour": {"used_percentage": 23, "resets_at": int(time.time()) + 2000}}}).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(response.stdout, b"existing:same output\n")
        self.assertEqual(response.returncode, 0)
        backups = list(self.config.glob("settings.json.herdr-usage-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        self.assertNotIn("private", usage._cache_path().read_text())
        self.assertEqual(stat.S_IMODE(usage._cache_path().stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
        self.assertEqual(usage.read_usage()["windows"][0]["used_percent"], 23)

    def test_install_is_idempotent(self):
        self.write_settings({"statusLine": {"type": "command", "command": "printf 'hello'"}})
        usage.install()
        first = usage._settings_path().read_bytes()
        usage.install()
        self.assertEqual(usage._settings_path().read_bytes(), first)
        self.assertEqual(len(list(self.config.glob("settings.json.herdr-usage-backup-*"))), 1)
        self.assertEqual(json.loads(first)["statusLine"]["command"].count("--statusline"), 1)

    def test_relocated_wrapper_is_replaced_without_nesting(self):
        old = "python3 '/old copy/claude_usage.py' --statusline '--forward=printf hello'"
        self.write_settings({"statusLine": {"type": "command", "command": old}})
        usage.install()
        command = json.loads(usage._settings_path().read_text())["statusLine"]["command"]
        self.assertEqual(usage._wrapper_forward(command), (True, "printf hello"))
        self.assertNotIn("old copy", command)

    def test_invalid_settings_are_never_overwritten(self):
        self.config.mkdir()
        for original in (b"not JSON", b"[]", b'{"statusLine":"bad"}'):
            with self.subTest(original=original):
                usage._settings_path().write_bytes(original)
                self.assertEqual(usage.install()["status"], "error")
                self.assertEqual(usage._settings_path().read_bytes(), original)
        self.assertEqual(list(self.config.glob("settings.json.herdr-usage-backup-*")), [])

    def test_symlinked_settings_remain_untouched(self):
        self.config.mkdir()
        target = self.root / "shared-settings.json"
        target.write_text('{"theme":"light"}')
        usage._settings_path().symlink_to(target)
        self.assertEqual(usage.install()["status"], "error")
        self.assertTrue(usage._settings_path().is_symlink())
        self.assertEqual(target.read_text(), '{"theme":"light"}')

    def test_no_cli_does_not_install(self):
        with patch.object(usage, "_claude_available", return_value=False):
            self.assertEqual(usage.read_usage()["status"], "unavailable")
            self.assertEqual(usage.install()["status"], "unavailable")
        self.assertFalse(usage._settings_path().exists())

    def test_setup_waits_for_next_response(self):
        self.assertEqual(usage.read_usage()["status"], "setup")
        self.assertFalse(usage.read_usage()["installed"])
        result = usage.install()
        self.assertEqual(result["status"], "setup")
        self.assertTrue(result["installed"])
        self.assertEqual(result["windows"], [])

    def test_expired_windows_are_removed(self):
        usage.install()
        self.cache_value({"rate_limits": {
            "five_hour": {"used_percentage": 100, "resets_at": int(time.time()) - 1},
            "seven_day": {"used_percentage": 45, "resets_at": int(time.time()) + 1000},
        }})
        result = usage.read_usage()
        self.assertEqual([window["id"] for window in result["windows"]], ["seven_day"])
        self.assertTrue(result["stale"])
        self.cache_value({"rate_limits": {
            "five_hour": {"used_percentage": 100, "resets_at": int(time.time()) - 1}}})
        result = usage.read_usage()
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["windows"], [])

    def test_old_cache_is_marked_stale(self):
        usage.install()
        self.cache_value({"rate_limits": {"seven_day": {"used_percentage": 62}}},
                         int(time.time()) - usage.STALE_AFTER - 1)
        result = usage.read_usage()
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["stale"])
        self.assertEqual(result["windows"][0]["used_percent"], 62)

    def test_corrupt_or_future_cache_is_not_displayed(self):
        usage.install()
        for data in (b"invalid", b"[]", b'{"updated_at":true}',
                     usage._json_bytes({"updated_at": int(time.time()) + 1000, "windows": []})):
            with self.subTest(data=data):
                usage._atomic_write(usage._cache_path(), data)
                result = usage.read_usage()
                self.assertEqual(result["status"], "unavailable")
                self.assertEqual(result["windows"], [])

    def test_cache_is_resanitized(self):
        usage.install()
        usage._atomic_write(usage._cache_path(), usage._json_bytes({
            "updated_at": int(time.time()), "email": "private@example.invalid", "windows": [
                {"id": "five_hour", "label": "private secret", "used_percent": 0, "reset_at": None},
                {"id": "account", "label": "private", "used_percent": 3},
            ]}))
        result = usage.read_usage()
        self.assertNotIn("private", json.dumps(result))
        self.assertEqual(result["windows"], [
            {"id": "five_hour", "label": "5h", "used_percent": 0.0, "reset_at": None}])

    def test_missing_rate_limits_clears_previous_observation(self):
        usage.install()
        self.feed({"rate_limits": {"five_hour": {"used_percentage": 31}}})
        self.assertEqual(usage.read_usage()["status"], "ok")
        self.feed({"session_id": "private", "context_window": {"used_percentage": 99}})
        self.assertEqual(usage.read_usage()["windows"], [])
        self.assertNotIn("private", usage._cache_path().read_text())

    def test_invalid_stdin_still_reaches_existing_command(self):
        response = subprocess.run([sys.executable, str(HELPER), "--statusline", "--forward=cat"],
                                  input=b"original input", stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(response.stdout, b"original input")
        self.assertFalse(usage._cache_path().exists())

    def test_separate_config_profiles_do_not_share_usage(self):
        usage.install()
        self.feed({"rate_limits": {"five_hour": {"used_percentage": 31}}})
        default_cache = usage._cache_path()
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.root / "another profile")}):
            usage.install()
            self.assertNotEqual(usage._cache_path(), default_cache)
            self.assertEqual(usage.read_usage()["windows"], [])
        self.assertEqual(usage.read_usage()["windows"][0]["used_percent"], 31)


if __name__ == "__main__":
    unittest.main()
