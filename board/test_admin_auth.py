from __future__ import annotations

import unittest

from admin_auth import AdminAuth, SESSION_COOKIE, admin_client_allowed


class MutableClock:
    def __init__(self):
        self.now = 1_000.0

    def __call__(self):
        return self.now


class AdminAuthTest(unittest.TestCase):
    def test_remote_admin_requires_explicit_https_cookie_contract(self):
        self.assertTrue(admin_client_allowed("127.0.0.1", allow_remote=False, secure_cookie=False))
        self.assertTrue(admin_client_allowed("::1", allow_remote=False, secure_cookie=False))
        self.assertFalse(admin_client_allowed("203.0.113.10", allow_remote=False, secure_cookie=False))
        self.assertFalse(admin_client_allowed("203.0.113.10", allow_remote=True, secure_cookie=False))
        self.assertTrue(admin_client_allowed("203.0.113.10", allow_remote=True, secure_cookie=True))

    def test_unconfigured_short_or_placeholder_password_is_disabled(self):
        self.assertFalse(AdminAuth("").configured)
        self.assertFalse(AdminAuth("CHANGE_ME").configured)
        self.assertFalse(AdminAuth("CHANGE_ME_WITH_AT_LEAST_16_CHARACTERS").configured)
        self.assertFalse(AdminAuth("too-short").configured)

    def test_login_cookie_session_csrf_and_logout(self):
        clock = MutableClock()
        auth = AdminAuth("correct horse battery staple", clock=clock)

        status, session = auth.login("correct horse battery staple", "browser")

        self.assertEqual(status, "authenticated")
        self.assertIsNotNone(session)
        cookie = auth.cookie_header(session)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        loaded = auth.session(f"{SESSION_COOKIE}={session.token}")
        self.assertEqual(loaded.csrf_token, session.csrf_token)
        self.assertTrue(auth.verify_csrf(loaded, session.csrf_token))
        self.assertFalse(auth.verify_csrf(loaded, "wrong"))
        auth.logout(loaded)
        self.assertIsNone(auth.session(f"{SESSION_COOKIE}={session.token}"))

    def test_failed_logins_are_rate_limited_and_expire(self):
        clock = MutableClock()
        auth = AdminAuth("correct horse battery staple", max_failures=2, clock=clock)

        self.assertEqual(auth.login("wrong", "browser")[0], "invalid")
        self.assertEqual(auth.login("wrong", "browser")[0], "invalid")
        self.assertEqual(auth.login("correct horse battery staple", "browser")[0], "rate_limited")
        clock.now += 301
        self.assertEqual(auth.login("correct horse battery staple", "browser")[0], "authenticated")

    def test_sessions_expire(self):
        clock = MutableClock()
        auth = AdminAuth("correct horse battery staple", session_seconds=60, clock=clock)
        _, session = auth.login("correct horse battery staple", "browser")
        clock.now += 61
        self.assertIsNone(auth.session(f"{SESSION_COOKIE}={session.token}"))


if __name__ == "__main__":
    unittest.main()
