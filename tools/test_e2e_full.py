import re
import unittest

from tools import e2e_full


class E2EFullPartsTests(unittest.TestCase):
    def test_step_table_renders_all_columns_and_rows(self):
        table = e2e_full.report_table([{
            "what": "approve | repeat",
            "call": "POST /api/disputes/id/approve",
            "http": 409,
            "result": "PASS: already filed",
            "seconds": 1.25,
        }])
        self.assertIn("| Step | What | Call | HTTP | Result | Seconds |", table)
        self.assertIn("approve \\| repeat", table)
        self.assertIn("| 1 |", table)
        self.assertIn("| 409 | PASS: already filed | 1.25 |", table)

    def test_expected_code_checks(self):
        self.assertTrue(e2e_full.expected_code(409, 409))
        self.assertFalse(e2e_full.expected_code(403, 409))
        self.assertTrue(e2e_full.code_is(422)(422, {}, "refused"))

    def test_path_b_observation_returns_shape_accepted_by_run_step(self):
        dispute = {"status": "WAITING_FOR_SELLER_RESPONSE", "links": [{"rel": "adjudicate"}]}
        reader_calls = []

        def fake_paypal_reader(token, dispute_id):
            reader_calls.append((token, dispute_id))
            return 200, dispute, "links ['adjudicate']"

        rows = []
        ok, result = e2e_full.run_step(
            rows, "Path B PayPal observation", "fake PayPal GET",
            e2e_full.path_b_observation("fake-token", "PP-FAKE", reader=fake_paypal_reader, delay=0),
            lambda code, _result, _detail: code == 200)

        self.assertTrue(ok)
        self.assertIs(result, dispute)
        self.assertEqual(reader_calls, [("fake-token", "PP-FAKE")])
        self.assertIn("status WAITING_FOR_SELLER_RESPONSE", rows[0]["result"])

    def test_c2_offer_passes_only_for_expected_offer_and_link_state(self):
        self.assertTrue(e2e_full.c2_offer_expected("OFFER", "12.00", set()))
        self.assertFalse(e2e_full.c2_offer_expected("ACCEPT", "12.00", set()))
        self.assertFalse(e2e_full.c2_offer_expected("OFFER", "10.00", set()))
        self.assertFalse(e2e_full.c2_offer_expected("OFFER", "12.00", {"make_offer"}))

    def test_tag_has_required_prefix_and_six_hex_digits(self):
        self.assertRegex(e2e_full.make_tag(), re.compile(r"^dd-e2e[0-9a-f]{6}$"))

    def test_paths_run_before_bad_paths_and_contact_sheets(self):
        self.assertEqual(e2e_full.step_order(False, False)["paths"],
                         ["path_a", "path_b", "bad_paths", "contact_sheets"])

    def test_repeat_approve_prefers_filed_path_a_then_path_b(self):
        self.assertEqual(e2e_full.step_order(True, True)["repeat_approve_case"], "path_a")
        self.assertEqual(e2e_full.step_order(False, True)["repeat_approve_case"], "path_b")
        self.assertIsNone(e2e_full.step_order(False, False)["repeat_approve_case"])

class DeskSessionTests(unittest.TestCase):
    def test_python_tools_keep_one_cookie_jar_between_requests(self):
        import email.message
        import io
        import urllib.request
        import urllib.response
        from unittest.mock import patch
        from tools import e2e_loop, owner_file

        for module, send in [
            (e2e_full, lambda: e2e_full.desk_request("GET", "/api/me")),
            (e2e_loop, lambda: e2e_loop.desk_post("/analyse", "test-key")),
            (owner_file, lambda: owner_file.post("/analyse", "test-key")),
        ]:
            with self.subTest(tool=module.__name__):
                processors = [handler for handler in module.DESK_OPENER.handlers
                              if isinstance(handler, urllib.request.HTTPCookieProcessor)]
                self.assertEqual(len(processors), 1)
                seen = []

                class Transport(urllib.request.HTTPSHandler):
                    handler_order = 100

                    def https_open(self, request):
                        seen.append(request.get_header("Cookie"))
                        headers = email.message.Message()
                        headers["Set-Cookie"] = "dd_session=test.signature; Secure; HttpOnly; Path=/"
                        response = urllib.response.addinfourl(io.BytesIO(b"{}"), headers, request.full_url, 200)
                        response.msg = "OK"
                        return response

                # Only the transport is replaced. Each tool retains its real cookie processor.
                local = urllib.request.build_opener(processors[0], Transport())
                with patch.object(module, "DESK", "https://desk.test"), patch.object(module, "DESK_OPENER", local):
                    self.assertEqual(send()[0], 200)
                    self.assertEqual(send()[0], 200)
                self.assertEqual(seen, [None, "dd_session=test.signature"])

    def test_python_filing_tools_send_the_analysed_version(self):
        from unittest.mock import patch
        from tools import e2e_loop, owner_file
        from contextlib import redirect_stdout
        import io

        for module, method in [(e2e_loop, "desk_post"), (owner_file, "post")]:
            calls = []

            def post(path, key, body=None):
                calls.append((path, body))
                if path.endswith("/analyse"):
                    return 200, {"run": {"version": "read-version", "decision": {"verdict": "ACCEPT"}}}
                return 422, {"filed": {"ok": False}}

            with self.subTest(tool=module.__name__), patch.object(module, method, post), redirect_stdout(io.StringIO()):
                if module is e2e_loop:
                    with patch.object(module, "owner_key", return_value="test-key"), patch("sys.argv", ["tool", "--dispute", "PP-TEST"]):
                        self.assertEqual(module.main(), 1)
                else:
                    with patch.object(module, "key", return_value="test-key"), patch("sys.argv", ["tool", "PP-TEST"]):
                        with self.assertRaises(SystemExit):
                            module.main()
            self.assertEqual(calls[-1], ("/api/disputes/PP-TEST/approve", {"version": "read-version"}))


if __name__ == "__main__":
    unittest.main()
