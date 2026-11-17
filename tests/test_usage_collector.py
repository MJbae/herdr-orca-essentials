"""Quota parsing and subprocess safety checks; no live provider requests."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock


MODULE = Path(__file__).resolve().parents[1] / "mods" / "project-usage" / "collect.py"
SPEC = importlib.util.spec_from_file_location("usage_collector", MODULE)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def usage_record(buckets):
    return {"status": "SUCCESS", "conversation_id": "", "num_turns": 0,
            "command": {"name": "usage", "data": {"groups": [{"buckets": buckets}]}}}


class CodexParsingTests(unittest.TestCase):
    def test_primary_can_be_weekly_and_secondary_absent(self):
        data = {"rateLimits": {"primary": {"usedPercent": 42, "windowDurationMins": 10080, "resetsAt": 1800000000}, "secondary": None}}
        value = collector.parse_codex(data, now=1790000000)
        self.assertEqual(value["windows"], [{"id": "codex-0-primary", "label": "Weekly", "used_percent": 42, "reset_at": 1800000000}])
        self.assertEqual(value["updated_at"], 1790000000)

    def test_multiple_limits_deduplicate_legacy_and_keep_distinct_windows(self):
        default = {"limitId": "codex", "primary": {"usedPercent": 12, "windowDurationMins": 300}, "secondary": {"usedPercent": 33, "windowDurationMins": 10080}}
        extra = {"limitName": "Codex Spark", "primary": {"usedPercent": 75, "windowDurationMins": 300}}
        value = collector.parse_codex({"rateLimits": default, "rateLimitsByLimitId": {"codex": default, "spark": extra}})
        self.assertEqual([w["label"] for w in value["windows"]], ["5h", "Weekly", "Codex Spark · 5h"])
        self.assertEqual([w["used_percent"] for w in value["windows"]], [12, 33, 75])

    def test_null_unknown_and_invalid_numbers_are_not_invented(self):
        for bad in (None, True, "10", -1, 101, float("nan"), float("inf")):
            value = collector.parse_codex({"rateLimits": {"primary": {"usedPercent": bad}}})
            self.assertEqual(value["status"], "unavailable")
            self.assertEqual(value["windows"], [])
            self.assertIsNone(value["updated_at"])
        value = collector.parse_codex({"rateLimits": {"primary": {"usedPercent": 0, "windowDurationMins": None, "resetsAt": None}}})
        self.assertEqual(value["windows"][0]["label"], "Primary")
        self.assertEqual(value["windows"][0]["used_percent"], 0)
        self.assertIsNone(value["windows"][0]["reset_at"])

    def test_credit_balance_keeps_provider_units_and_decimal_precision(self):
        value = collector.parse_codex({"rateLimits": {"credits": {"hasCredits": True, "unlimited": False, "balance": "12.3400"}}})
        self.assertEqual(value["credits"], {"has_credits": True, "unlimited": False, "balance": "12.3400"})
        self.assertNotIn("$", json.dumps(value))
        self.assertNotIn("tokens", json.dumps(value))
        for balance in (None, 15, "email@example.com", "$15", "nan"):
            self.assertIsNone(collector.credits_snapshot({"hasCredits": True, "unlimited": True, "balance": balance})["balance"])
        self.assertIsNone(collector.credits_snapshot({"balance": "10"}))

    def test_account_fields_and_opaque_ids_never_leave_parser(self):
        data = {"accountId": "private-account", "email": "person@example.com", "error": "secret-provider-error", "rateLimits": {"limitId": "opaque-private-id", "limitName": "person@example.com", "primary": {"usedPercent": 20}}}
        public = json.dumps(collector.parse_codex(data))
        for private in ("private-account", "person@example.com", "secret-provider-error", "opaque-private-id"):
            self.assertNotIn(private, public)


class AntigravityParsingTests(unittest.TestCase):
    def test_ndjson_usage_multiple_windows_and_disabled_buckets(self):
        record = usage_record([
            {"id": "private-bucket-id", "name": "Gemini Pro", "window": "5h", "remaining_fraction": 0.75, "reset_time": "2026-11-17T00:00:00Z"},
            {"id": "weekly", "name": "Gemini Pro", "window": "weekly", "remaining_fraction": 0.321, "reset_time": None},
            {"name": "Disabled", "remaining_fraction": 0, "disabled": True},
            {"name": "Missing", "remaining_fraction": None},
        ])
        value = collector.parse_antigravity(json.dumps({"status": "STARTED"}) + "\n" + json.dumps(record), now=123)
        self.assertEqual(value["status"], "ok")
        self.assertEqual(value["updated_at"], 123)
        self.assertEqual([w["label"] for w in value["windows"]], ["Gemini Pro · 5h", "Gemini Pro · Weekly"])
        self.assertEqual([w["used_percent"] for w in value["windows"]], [25, 67.9])
        self.assertEqual(value["windows"][0]["reset_at"], 1794873600)
        self.assertIsNone(value["windows"][1]["reset_at"])
        self.assertNotIn("private-bucket-id", json.dumps(value))

    def test_missing_or_invalid_fractions_do_not_mean_zero_usage(self):
        for fraction in (None, "0.5", True, -0.1, 1.1, float("nan")):
            value = collector.parse_antigravity(json.dumps(usage_record([{"name": "Model", "remaining_fraction": fraction}])))
            self.assertEqual(value["status"], "unavailable")
            self.assertEqual(value["windows"], [])

    def test_group_names_disambiguate_identical_bucket_names(self):
        record = {"status": "SUCCESS", "command": {"name": "usage", "data": {"groups": [
            {"name": "Gemini", "buckets": [{"name": "Pro", "remaining_fraction": 0.5, "window": "5h"}]},
            {"name": "Claude", "buckets": [{"name": "Pro", "remaining_fraction": 0.9, "window": "5h"}]},
        ]}}}
        value = collector.parse_antigravity(json.dumps(record))
        self.assertEqual([w["label"] for w in value["windows"]], ["Gemini · Pro · 5h", "Claude · Pro · 5h"])

    def test_named_model_is_preserved_when_it_is_the_only_group_bucket(self):
        record = {"status": "SUCCESS", "command": {"name": "usage", "data": {"groups": [
            {"name": "Gemini Models", "buckets": [{"name": "Gemini 4 Argon", "remaining_fraction": 0.5, "window": "weekly"}]},
        ]}}}
        value = collector.parse_antigravity(json.dumps(record))
        self.assertEqual(value["windows"][0]["label"], "Gemini 4 Argon · Weekly")

    def test_real_usage_envelope_with_synthetic_quota_values(self):
        def bucket(name, cadence, remaining):
            return {"id": "private-bucket", "name": name, "window": cadence,
                    "remaining_fraction": remaining, "reset_time": "2026-11-17T00:00:00Z"}
        record = {"status": "SUCCESS", "conversation_id": "", "num_turns": 0,
                  "command": {"name": "usage", "data": {"groups": [
                      {"name": "Gemini Models", "buckets": [bucket("Weekly Limit Remaining", "weekly", 0.8), bucket("Five Hour Limit Remaining", "5h", 0.5)]},
                      {"name": "Claude and GPT models", "buckets": [bucket("Weekly Limit Remaining", "weekly", 0.6), bucket("Five Hour Limit Remaining", "5h", 0.3)]},
                      {"name": "Gemini 4 Argon", "buckets": [bucket("Gemini 4 Argon Weekly Limit", "weekly", 1)]},
                  ]}}}
        value = collector.parse_antigravity(json.dumps(record))
        self.assertEqual(value["status"], "ok")
        self.assertEqual([w["label"] for w in value["windows"]], ["Gemini · Weekly", "Gemini · 5h", "Claude + GPT · Weekly", "Claude + GPT · 5h", "Gemini 4 Argon · Weekly"])
        self.assertEqual([w["used_percent"] for w in value["windows"]], [20, 50, 40, 70, 0])
        self.assertNotIn("private-bucket", json.dumps(value))

    def test_empty_and_null_conversation_fields_are_not_model_turns(self):
        for conversation_id in ("", None):
            for turns in (0, None):
                record = usage_record([{"name": "Model", "remaining_fraction": 0.5}])
                record.update(conversation_id=conversation_id, num_turns=turns)
                self.assertEqual(collector.parse_antigravity(json.dumps(record))["status"], "ok")

    def test_banners_are_ignored_only_when_valid_quota_exists(self):
        text = "Antigravity update notice\n{incomplete banner\n" + json.dumps(usage_record([{"name": "Model", "remaining_fraction": 0.5}]))
        self.assertEqual(collector.parse_antigravity(text)["status"], "ok")
        with self.assertRaises(collector.UsageError):
            collector.parse_antigravity("Antigravity update notice\n{incomplete banner\n")

    def test_missing_usage_data_never_becomes_zero_usage(self):
        for data in (None, {}, {"groups": None}, {"groups": [None]}, {"groups": [{"buckets": None}]}):
            record = usage_record([])
            record["command"]["data"] = data
            with self.assertRaises(collector.UsageError):
                collector.parse_antigravity(json.dumps(record))

    def test_malformed_or_wrong_command_is_rejected(self):
        for text in ("", "{broken", "provider error includes secret", '{"status":"SUCCESS","command":{"name":"chat"}}', '{"status":"SUCCESS","command":{"name":"usage","data":null}}'):
            with self.assertRaises(collector.UsageError):
                collector.parse_antigravity(text)

    def test_conversation_records_rejected_even_after_valid_usage(self):
        valid = json.dumps(usage_record([{"name": "Model", "remaining_fraction": 0.5}]))
        for conversation in ({"num_turns": 1}, {"conversation_id": "private-session"}, {"result": {"num_turns": 2}}, {"num_turns": "1"}):
            with self.assertRaises(collector.UnsupportedUsage):
                collector.parse_antigravity(valid + "\n" + json.dumps(conversation))
        self.assertEqual(collector.parse_antigravity(valid + '\n{"num_turns":0}')["status"], "ok")

    def test_version_parser_fails_closed(self):
        for text in ("1.5.10\n", "agy 1.5.10", "Antigravity CLI v1.5.10", "1.5.10+build.5"):
            self.assertEqual(collector.parse_agy_version(text), (1, 5, 10))
        for text in ("1.1.11-beta", "1.5", "previous 1.0.0 current 1.5.10", "1.5.10\nsecret", "999"):
            self.assertIsNone(collector.parse_agy_version(text))


class CommandSafetyTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.guard = Path(folder.name) / "guard.json"
        patcher = mock.patch.object(collector, "antigravity_guard_path", return_value=self.guard)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_missing_clis_do_not_start_processes(self):
        with mock.patch.object(collector.shutil, "which", return_value=None), mock.patch.object(collector, "BoundedProcess") as process:
            self.assertEqual(collector.collect_codex()["status"], "unavailable")
            self.assertEqual(collector.collect_antigravity()["status"], "unavailable")
            process.assert_not_called()

    def test_supported_stable_versions_use_the_read_only_usage_command(self):
        for version in ("1.1.11", "1.5.10", "1.6.0"):
            with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
                factory.return_value.__enter__.return_value.read_all.side_effect = [version, json.dumps(usage_record([{"name": "Model", "remaining_fraction": 0.5}]))]
                self.assertEqual(collector.collect_antigravity()["status"], "ok")
                self.assertEqual(factory.call_count, 2)

    def test_codex_uses_only_account_rpc_and_never_refreshes_token(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/codex"), mock.patch.object(collector, "BoundedProcess") as factory:
            process = factory.return_value.__enter__.return_value
            process.rpc.side_effect = [{}, {"account": {"type": "chatgpt", "email": "private@example.com"}}, {"rateLimits": {"primary": {"usedPercent": 40, "windowDurationMins": 10080}}}]
            value = collector.collect_codex()
            self.assertEqual(factory.call_args.args[0], ["/cli/codex", "--no-daemon", "app-server", "--stdio"])
            self.assertEqual([c.args[1] for c in process.rpc.call_args_list], ["initialize", "account/read", "account/rateLimits/read"])
            self.assertEqual(process.rpc.call_args_list[1].args[2], {"refreshToken": False})
            process.send.assert_called_once_with({"method": "initialized", "params": {}})
            self.assertNotIn("private@example.com", json.dumps(value))

    def test_codex_api_key_login_never_requests_account_quota(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/codex"), mock.patch.object(collector, "BoundedProcess") as factory:
            process = factory.return_value.__enter__.return_value
            process.rpc.side_effect = [{}, {"account": {"type": "apiKey"}}]
            self.assertEqual(collector.collect_codex()["status"], "unavailable")
            self.assertEqual(process.rpc.call_count, 2)

    def test_old_or_unknown_agy_does_not_run_usage(self):
        for version in ("1.1.10", "unparseable", "1.1.11-beta"):
            with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
                factory.return_value.__enter__.return_value.read_all.return_value = version
                self.assertEqual(collector.collect_antigravity()["status"], "setup")
                self.assertEqual(factory.call_count, 1)
                self.assertEqual(factory.call_args.args[0], ["/cli/agy", "--version"])

    def test_agy_uses_exact_usage_command_and_disables_auto_update(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
            factory.return_value.__enter__.return_value.read_all.side_effect = ["1.5.10", json.dumps(usage_record([{"name": "Model", "remaining_fraction": 0.5}]))]
            self.assertEqual(collector.collect_antigravity()["status"], "ok")
            self.assertEqual(factory.call_args.args[0], ["/cli/agy", "-p", "/usage", "--output-format", "json", "--print-timeout", "20s"])
            self.assertEqual(factory.call_args.args[2]["AGY_CLI_DISABLE_AUTO_UPDATE"], "true")
            self.assertFalse(self.guard.exists())

    def test_agy_uncertain_response_keeps_probe_latch(self):
        for response in (collector.UsageError("nonzero or timeout"), "{malformed"):
            with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
                self.guard.unlink(missing_ok=True)
                factory.return_value.__enter__.return_value.read_all.side_effect = ["1.5.10", response]
                self.assertEqual(collector.collect_antigravity()["status"], "error")
                self.assertTrue(collector.antigravity_version_blocked((1, 5, 10)))
                self.assertEqual(collector.antigravity_guard_reason((1, 5, 10)), "probe")

    def test_transient_failure_pause_expires_and_remains_retryable(self):
        collector.block_antigravity_version((1, 5, 10), reason="probe", now=1000)
        self.assertTrue(collector.antigravity_version_blocked((1, 5, 10), now=1299))
        self.assertFalse(collector.antigravity_version_blocked((1, 5, 10), now=1300))
        with mock.patch.object(collector.time, "time", return_value=1100), mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
            factory.return_value.__enter__.return_value.read_all.return_value = "1.5.10"
            self.assertEqual(collector.collect_antigravity()["status"], "error")
            self.assertEqual(factory.call_count, 1)

    def test_legacy_false_positive_guard_migrates_after_success(self):
        self.guard.write_text(json.dumps({"version": [1, 5, 10], "blocked": True}))
        self.assertFalse(collector.antigravity_version_blocked((1, 5, 10)))
        with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
            factory.return_value.__enter__.return_value.read_all.side_effect = ["1.5.10", json.dumps(usage_record([{"name": "Model", "remaining_fraction": 0.5}]))]
            self.assertEqual(collector.collect_antigravity()["status"], "ok")
        self.assertFalse(self.guard.exists())

    def test_usage_polling_suppresses_browser_launch(self):
        with collector.antigravity_usage_environment({"PATH": "/usr/bin"}) as env:
            guard_directory = Path(env["BROWSER"]).parent
            self.assertEqual(env["PATH"].split(collector.os.pathsep)[0], str(guard_directory))
            for name in ("open", "xdg-open"):
                guard = guard_directory / name
                self.assertEqual(guard.read_text(), "#!/bin/sh\nexit 1\n")
                self.assertEqual(guard.stat().st_mode & 0o777, 0o700)
        self.assertFalse(guard_directory.exists())

    def test_agy_probe_is_persisted_before_command_and_clear_after_valid_empty_usage(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
            def read_output():
                if factory.call_count == 1:
                    return "1.5.10"
                self.assertTrue(collector.antigravity_version_blocked((1, 5, 10)))
                return json.dumps(usage_record([]))
            factory.return_value.__enter__.return_value.read_all.side_effect = read_output
            self.assertEqual(collector.collect_antigravity()["status"], "unavailable")
            self.assertFalse(self.guard.exists())

    def test_agy_cannot_run_when_guard_cannot_be_saved(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory, mock.patch.object(collector, "block_antigravity_version", return_value=False):
            factory.return_value.__enter__.return_value.read_all.return_value = "1.5.10"
            self.assertEqual(collector.collect_antigravity()["status"], "setup")
            self.assertEqual(factory.call_count, 1)

    def test_provider_failures_return_generic_message(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/codex"), mock.patch.object(collector, "BoundedProcess", side_effect=collector.UsageError("private raw response")):
            value = collector.collect_codex()
            self.assertEqual(value["status"], "error")
            self.assertNotIn("private raw response", json.dumps(value))

    def test_prompt_like_response_disables_automatic_checks(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
            factory.return_value.__enter__.return_value.read_all.side_effect = ["1.5.10", '{"num_turns":1,"conversation_id":"private"}']
            value = collector.collect_antigravity()
            self.assertEqual(value["status"], "setup")
            self.assertNotIn("private", json.dumps(value))
            self.assertEqual(json.loads(self.guard.read_text()), {"revision": 2, "version": [1, 5, 10], "blocked": True, "reason": "conversation"})
            self.assertEqual(self.guard.stat().st_mode & 0o777, 0o600)

    def test_prompt_marker_after_malformed_banner_is_still_permanently_blocked(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
            factory.return_value.__enter__.return_value.read_all.side_effect = ["1.5.10", 'banner\n{malformed\n{"num_turns":1}']
            self.assertEqual(collector.collect_antigravity()["status"], "setup")
            self.assertEqual(collector.antigravity_guard_reason((1, 5, 10)), "conversation")

    def test_nonzero_cli_with_conversation_output_is_permanently_blocked(self):
        executable = self.guard.parent / "fake-agy"
        executable.write_text("#!" + sys.executable + "\nimport sys\n"
                              "if '--version' in sys.argv:\n    print('1.5.10')\n"
                              "else:\n    print('{\"num_turns\":1,\"conversation_id\":\"private-session\"}')\n    sys.exit(1)\n")
        executable.chmod(0o700)
        with mock.patch.object(collector.shutil, "which", return_value=str(executable)):
            value = collector.collect_antigravity()
        self.assertEqual(value["status"], "setup")
        self.assertEqual(collector.antigravity_guard_reason((1, 5, 10)), "conversation")
        self.assertNotIn("private-session", json.dumps(value))

    def test_nonzero_cli_with_valid_quota_is_not_accepted(self):
        with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
            factory.return_value.__enter__.return_value.read_all.side_effect = ["1.5.10", collector.ProcessFailure(json.dumps(usage_record([{"name": "Model", "remaining_fraction": 0.5}])))]
            value = collector.collect_antigravity()
            self.assertEqual(value["status"], "error")
            self.assertEqual(value["windows"], [])
            self.assertEqual(collector.antigravity_guard_reason((1, 5, 10)), "probe")

    def test_timed_out_process_preserves_bounded_conversation_output(self):
        with self.assertRaises(collector.ProcessFailure) as failure:
            with collector.BoundedProcess([sys.executable, "-c", 'import time; print(\'{"num_turns":1}\', flush=True); time.sleep(20)'], time.monotonic() + 0.2) as process:
                process.read_all()
        with self.assertRaises(collector.UnsupportedUsage):
            collector.antigravity_records(failure.exception.output)

    def test_blocked_agy_version_never_runs_usage_again(self):
        collector.block_antigravity_version((1, 5, 10))
        with mock.patch.object(collector.shutil, "which", return_value="/cli/agy"), mock.patch.object(collector, "BoundedProcess") as factory:
            factory.return_value.__enter__.return_value.read_all.return_value = "1.5.10"
            self.assertEqual(collector.collect_antigravity()["status"], "setup")
            self.assertEqual(factory.call_count, 1)
        self.assertFalse(collector.antigravity_version_blocked((1, 5, 11)))

    def test_subprocess_output_is_bounded_and_process_is_reaped(self):
        with self.assertRaises(collector.UsageError):
            with collector.BoundedProcess([sys.executable, "-c", "print('x' * 600000)"], time.monotonic() + 3) as process:
                process.read_all()
        self.assertIsNotNone(process.process.poll())

    def test_subprocess_deadline_is_enforced_and_process_is_reaped(self):
        started = time.monotonic()
        with self.assertRaises(collector.UsageError):
            with collector.BoundedProcess([sys.executable, "-c", "import time; time.sleep(20)"], time.monotonic() + 0.05) as process:
                process.read_all()
        self.assertIsNotNone(process.process.poll())
        self.assertLess(time.monotonic() - started, 2)


if __name__ == "__main__":
    unittest.main()
