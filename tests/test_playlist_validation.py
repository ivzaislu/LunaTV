import os
import tempfile
import unittest
from unittest import mock

import requests

import test_m3u_playlists as validator


class MockResponse:
    def __init__(self, status_code=200, headers=None, url="https://example.test/stream.m3u8", body_chunks=None):
        self.status_code = status_code
        self.headers = headers or {}
        self.url = url
        self._body_chunks = body_chunks or [b"#EXTM3U\n"]

    def close(self):
        pass

    def iter_content(self, chunk_size=512):
        yield from self._body_chunks


class PlaylistValidatorTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)

    def _write_playlist(self, lines):
        path = os.path.join(self.tmpdir.name, "test.m3u")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("#EXTM3U\n")
            for line in lines:
                fh.write(f"{line}\n")
        return path

    def test_iter_m3u_streams_filters_comments(self):
        path = self._write_playlist([
            "#EXTINF:-1,Sample",
            " https://example.com/one.m3u8 ",
            "#EXTINF:-1,Another",
            "http://example.org/two.m3u8",
            "# comment",
            "invalid://not-used",
        ])
        streams = list(validator.iter_m3u_streams(path))
        self.assertEqual(streams, ["https://example.com/one.m3u8", "http://example.org/two.m3u8"])

    def test_check_playlist_head_success(self):
        path = self._write_playlist(["https://example.com/stream.m3u8"])

        head_response = MockResponse(
            status_code=200,
            headers={"content-type": "application/vnd.apple.mpegurl"},
            url="https://example.com/stream.m3u8",
        )

        with mock.patch.object(validator.requests, "head", return_value=head_response) as head_mock, mock.patch.object(
            validator.requests, "get"
        ) as get_mock:
            results = validator.check_playlist(path, timeout=5, playlist_name="test", concurrency=1)

        head_mock.assert_called_once()
        get_mock.assert_not_called()
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].ok)
        self.assertIn("HEAD 200", results[0].details)

    def test_check_playlist_fallback_to_get(self):
        path = self._write_playlist(["https://example.com/stream.m3u8"])

        def head_side_effect(*args, **kwargs):
            response = MockResponse(status_code=404, headers={"content-type": "text/html"})
            return response

        get_response = MockResponse(
            status_code=200,
            headers={"content-type": "application/vnd.apple.mpegurl"},
            body_chunks=[b"#EXTM3U\n#EXTINF:-1\n"],
        )

        with mock.patch.object(validator.requests, "head", side_effect=head_side_effect) as head_mock, mock.patch.object(
            validator.requests, "get", return_value=get_response
        ) as get_mock:
            results = validator.check_playlist(path, timeout=5, playlist_name="test", concurrency=1)

        head_mock.assert_called_once()
        get_mock.assert_called_once()
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].ok)
        self.assertIn("GET 200", results[0].details)
        self.assertIn("after HEAD returned 404", results[0].details)

    def test_check_playlist_failure(self):
        path = self._write_playlist(["https://example.com/offline.m3u8"])

        def head_side_effect(*args, **kwargs):
            raise requests.ConnectionError("head failed")

        def get_side_effect(*args, **kwargs):
            raise requests.Timeout("timeout")

        with mock.patch.object(validator.requests, "head", side_effect=head_side_effect), mock.patch.object(
            validator.requests, "get", side_effect=get_side_effect
        ):
            results = validator.check_playlist(path, timeout=5, playlist_name="test", concurrency=1)

        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].ok)
        self.assertIn("timeout", results[0].details)

    def test_run_no_playlists(self):
        code = validator.run(self.tmpdir.name, timeout=5, concurrency=1)
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
