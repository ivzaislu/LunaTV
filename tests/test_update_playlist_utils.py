import json
import os
import tempfile
import unittest
from unittest import mock

import update_playlist


class UpdatePlaylistUtilsTests(unittest.TestCase):
    def test_stream_line_regex_accepts_legacy_and_current_ports(self):
        samples = {
            "http://127.0.0.1:5000/stream/demo": "demo",
            "http://127.0.0.1:6060/stream/demo-hd": "demo-hd",
            "http://localhost:7777/stream/another": "another",
        }
        for line, expected_slug in samples.items():
            with self.subTest(line=line):
                match = update_playlist.STREAM_LINE_RE.match(line)
                self.assertIsNotNone(match)
                self.assertEqual(match.group(1), expected_slug)

    def test_get_live_stream_url_uses_url_cache_field(self):
        cached_url = "https://cdn.example.test/live/index.m3u8"
        with mock.patch.object(
            update_playlist,
            "cache_get",
            return_value={"url": cached_url, "source_url": "https://example.test/channel"},
        ), mock.patch.object(
            update_playlist,
            "validate_m3u8_url",
            return_value=True,
        ) as validate_mock, mock.patch.object(
            update_playlist,
            "run_js_extractor",
        ) as extractor_mock, mock.patch.object(
            update_playlist,
            "cache_set",
        ) as cache_set_mock:
            result = update_playlist.get_live_stream_url(
                "https://example.test/channel",
                slug="demo",
                script_path="fake.js",
                timeout_sec=5,
            )

        self.assertEqual(result, cached_url)
        validate_mock.assert_called_once_with(cached_url)
        extractor_mock.assert_not_called()
        cache_set_mock.assert_called_once_with(
            "demo",
            cached_url,
            "https://example.test/channel",
        )

    def test_update_playlist_writes_configured_proxy_port(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = os.path.join(tmp, "config")
            m3u_dir = os.path.join(tmp, "m3u")
            os.makedirs(config_dir)
            os.makedirs(m3u_dir)

            channels_path = os.path.join(config_dir, "channels.json")
            with open(channels_path, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "demo": {
                            "name": "Demo TV",
                            "url": "https://example.test/demo",
                        }
                    },
                    fh,
                )

            old_values = {
                "CHANNELS_PATH": update_playlist.CHANNELS_PATH,
                "M3U_DIR": update_playlist.M3U_DIR,
                "M3U8_CACHE_PATH": update_playlist.M3U8_CACHE_PATH,
                "PROXY_PORT": update_playlist.PROXY_PORT,
                "SITE_CONTROLLER": update_playlist.SITE_CONTROLLER,
            }
            try:
                update_playlist.CHANNELS_PATH = channels_path
                update_playlist.M3U_DIR = m3u_dir
                update_playlist.M3U8_CACHE_PATH = os.path.join(config_dir, "m3u8_cache.json")
                update_playlist.PROXY_PORT = 6060
                update_playlist.SITE_CONTROLLER = {}

                with mock.patch.object(update_playlist, "load_m3u8_cache", return_value={}), mock.patch.object(
                    update_playlist,
                    "save_m3u8_cache",
                ), mock.patch.object(
                    update_playlist,
                    "get_live_stream_url",
                    return_value="https://cdn.example.test/demo.m3u8",
                ):
                    update_playlist.update_playlist()

                playlist_path = os.path.join(m3u_dir, "example.test.m3u")
                with open(playlist_path, "r", encoding="utf-8") as fh:
                    playlist = fh.read()
                self.assertIn("http://127.0.0.1:6060/stream/demo", playlist)
                self.assertNotIn("127.0.0.1:5000", playlist)
            finally:
                for key, value in old_values.items():
                    setattr(update_playlist, key, value)


if __name__ == "__main__":
    unittest.main()
