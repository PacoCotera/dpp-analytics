from __future__ import annotations

import gzip
import unittest

from response_transport import (
    accepts_gzip,
    compress_response,
    compressible_content_type,
    gzip_body,
)


class ResponseTransportTest(unittest.TestCase):
    def test_accepts_supported_gzip_header(self):
        self.assertTrue(accepts_gzip("br, gzip"))
        self.assertTrue(accepts_gzip("br, gzip;q=0.5"))
        self.assertTrue(accepts_gzip("*;q=0.2"))

    def test_rejects_disabled_or_missing_gzip(self):
        self.assertFalse(accepts_gzip(""))
        self.assertFalse(accepts_gzip("br"))
        self.assertFalse(accepts_gzip("gzip;q=0"))
        self.assertFalse(accepts_gzip("gzip;q=invalid"))

    def test_compressible_content_types(self):
        self.assertTrue(compressible_content_type("application/json"))
        self.assertTrue(compressible_content_type("text/css; charset=utf-8"))
        self.assertTrue(compressible_content_type("image/svg+xml"))
        self.assertFalse(compressible_content_type("image/png"))
        self.assertFalse(compressible_content_type("application/zip"))

    def test_gzip_body_is_deterministic_and_reversible(self):
        body = b"dpp analytics response " * 1000
        first = gzip_body(body)
        second = gzip_body(body)
        self.assertIs(first, second)
        self.assertLess(len(first), len(body))
        self.assertEqual(gzip.decompress(first), body)

    def test_compress_response_sets_cache_safe_headers(self):
        body = b"reporting payload " * 1000
        compressed, headers = compress_response("application/json", body, "br, gzip")
        self.assertEqual(headers, {"Vary": "Accept-Encoding", "Content-Encoding": "gzip"})
        self.assertEqual(gzip.decompress(compressed), body)

        plain, plain_headers = compress_response("application/json", body, "br")
        self.assertIs(plain, body)
        self.assertEqual(plain_headers, {"Vary": "Accept-Encoding"})

    def test_compress_response_leaves_binary_content_untouched(self):
        body = b"not really a png" * 1000
        result, headers = compress_response("image/png", body, "gzip")
        self.assertIs(result, body)
        self.assertEqual(headers, {})


if __name__ == "__main__":
    unittest.main()
