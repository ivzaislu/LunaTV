import json
import os
import tempfile
import unittest
from unittest import mock

import proxy_server


class ProxyDashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._old_m3u = proxy_server.M3U_DIR
        self._old_config = proxy_server.CONFIG_DIR
        self._old_channels = proxy_server.CHANNELS_FILE
        proxy_server.M3U_DIR = self.tmp.name
        proxy_server.CONFIG_DIR = self.tmp.name
        proxy_server.CHANNELS_FILE = os.path.join(self.tmp.name, "channels.json")
        self.client = proxy_server.app.test_client()
        self.addCleanup(self._restore_globals)

    def _restore_globals(self):
        proxy_server.M3U_DIR = self._old_m3u
        proxy_server.CONFIG_DIR = self._old_config
        proxy_server.CHANNELS_FILE = self._old_channels

    def test_api_playlists_empty(self):
        resp = self.client.get("/api/playlists")
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertEqual(payload["items"], [])

    def test_api_playlists_lists_files(self):
        path = os.path.join(self.tmp.name, "demo.m3u")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("#EXTM3U\n")
        resp = self.client.get("/api/playlists")
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertEqual(payload["items"], ["demo.m3u"])

    def test_api_channels_reads_titles(self):
        data = {
            "news": {"title": "News HD", "url": "http://example"},
            "music": "http://example/music",
        }
        with open(proxy_server.CHANNELS_FILE, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        resp = self.client.get("/api/channels")
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertEqual(len(payload["items"]), 2)
        first = payload["items"][0]
        self.assertIn("slug", first)

    def test_api_channels_with_source(self):
        data = {
            "music": {"name": "Music", "url": "http://example/music"},
        }
        with open(proxy_server.CHANNELS_FILE, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        resp = self.client.get("/api/channels?withSource=1")
        payload = resp.get_json()
        self.assertEqual(payload["items"], [{"slug": "music", "name": "Music", "url": "http://example/music"}])

    def test_navigation_pages_render(self):
        for url in ("/", "/playlists", "/channels", "/player", "/scanner", "/settings"):
            resp = self.client.get(url)
            self.assertEqual(resp.status_code, 200, msg=f"{url} should render")

    def test_run_action_invokes_subprocess(self):
        dummy_action = {
            "label": "Dummy",
            "command": ["echo", "hello"],
            "timeout": 2,
        }
        fake_proc = mock.Mock()
        fake_proc.communicate.return_value = ("ok", None)
        fake_proc.poll.return_value = 0
        with mock.patch.object(proxy_server, "ACTION_CATALOG", {"dummy": dummy_action}):
            with mock.patch.object(proxy_server.subprocess, "Popen", return_value=fake_proc) as popen_mock:
                resp = self.client.post("/api/actions/dummy")
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertTrue(payload["ok"])
        popen_mock.assert_called_once_with(
            dummy_action["command"],
            cwd=proxy_server.BASE_DIR,
            stdout=mock.ANY,
            stderr=mock.ANY,
            text=True,
            env=None,
        )

    def test_run_action_unknown(self):
        resp = self.client.post("/api/actions/unknown")
        self.assertEqual(resp.status_code, 404)
        payload = resp.get_json()
        self.assertFalse(payload["ok"])

    def test_run_scanner_requires_start_url(self):
        resp = self.client.post("/api/actions/run-scanner", json={})
        self.assertEqual(resp.status_code, 400)
        payload = resp.get_json()
        self.assertFalse(payload["ok"])

    def test_run_scanner_appends_args(self):
        fake_proc = mock.Mock()
        fake_proc.communicate.return_value = ("ok", None)
        fake_proc.poll.return_value = 0
        with mock.patch.object(proxy_server.subprocess, "Popen", return_value=fake_proc) as popen_mock:
            resp = self.client.post(
                "/api/actions/run-scanner",
                json={"startUrl": "https://example.org/page", "siteTag": "demo"},
            )
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertTrue(payload["ok"])
        expected_cmd = list(proxy_server.ACTION_CATALOG["run-scanner"]["command"]) + [
            "--start-url",
            "https://example.org/page",
            "--site-tag",
            "demo",
        ]
        popen_mock.assert_called_once_with(
            expected_cmd,
            cwd=proxy_server.BASE_DIR,
            stdout=mock.ANY,
            stderr=mock.ANY,
            text=True,
            env=None,
        )

    def test_settings_api_structure(self):
        resp = self.client.get("/api/settings")
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertIn("paths", payload)
        self.assertIn("proxy", payload)
        self.assertIn("scanner", payload)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
