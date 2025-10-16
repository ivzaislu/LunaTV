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
        self._settings_backup = proxy_server.CURRENT_SETTINGS.copy()
        proxy_server._apply_settings(
            {
                "CONFIG_DIR": self.tmp.name,
                "M3U_DIR": self.tmp.name,
            },
            persist=False,
        )
        proxy_server.CACHE_FILE = os.path.join(proxy_server.CONFIG_DIR, "m3u8_cache.json")
        proxy_server.CHANNELS_FILE = os.path.join(proxy_server.CONFIG_DIR, "channels.json")
        self.client = proxy_server.app.test_client()
        self.addCleanup(self._restore_globals)

    def _restore_globals(self):
        proxy_server._apply_settings(self._settings_backup, persist=False)

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
        self.assertEqual(
            payload["items"],
            [
                {
                    "slug": "music",
                    "name": "Music",
                    "group": "",
                    "description": "",
                    "logo": "",
                    "favorite": False,
                    "epgId": "",
                    "url": "http://example/music",
                }
            ],
        )

    def test_channel_editor_crud(self):
        payload = {
            "slug": "demo",
            "name": "Demo TV",
            "url": "https://example.org/demo",
            "group": "Общие",
            "description": "Тестовое описание",
            "logo": "https://example.org/logo.png",
            "epgId": "demo.epg",
            "favorite": True,
        }
        resp = self.client.post("/api/channels", json=payload)
        self.assertEqual(resp.status_code, 200)
        created = resp.get_json()
        self.assertTrue(created["ok"])
        self.assertEqual(created["item"]["slug"], "demo")
        with open(proxy_server.CHANNELS_FILE, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        self.assertIn("demo", stored)
        self.assertEqual(stored["demo"]["group"], "Общие")
        self.assertEqual(stored["demo"]["epg_id"], "demo.epg")
        self.assertTrue(stored["demo"].get("favorite"))

        update_payload = {
            "slug": "demo-hd",
            "name": "Demo TV HD",
            "url": "https://example.org/demo-hd",
            "group": "HD",
            "description": "HD версия",
            "logo": "",
            "epgId": "demo.hd",
            "favorite": False,
        }
        resp = self.client.put("/api/channels/demo", json=update_payload)
        self.assertEqual(resp.status_code, 200)
        updated = resp.get_json()
        self.assertTrue(updated["ok"])
        self.assertEqual(updated["item"]["slug"], "demo-hd")
        with open(proxy_server.CHANNELS_FILE, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        self.assertNotIn("demo", stored)
        self.assertIn("demo-hd", stored)
        self.assertEqual(stored["demo-hd"]["group"], "HD")
        self.assertEqual(stored["demo-hd"].get("epg_id"), "demo.hd")
        self.assertNotIn("favorite", stored["demo-hd"])  # false не сохраняется

        resp = self.client.delete("/api/channels/demo-hd")
        self.assertEqual(resp.status_code, 200)
        removed = resp.get_json()
        self.assertTrue(removed["ok"])
        with open(proxy_server.CHANNELS_FILE, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        self.assertEqual(stored, {})

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
        self.assertIn("groups", payload)
        self.assertTrue(any(group.get("fields") for group in payload["groups"]))

    def test_settings_update_changes_cache_ttl(self):
        resp = self.client.post(
            "/api/settings",
            json={"values": {"CACHE_TTL_SEC": 1234, "CLEAN_TMP_AFTER_JS": False}},
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(proxy_server.CACHE_TTL_SEC, 1234)
        self.assertFalse(proxy_server.CLEAN_TMP_AFTER_JS)
        self.assertEqual(os.environ.get("CACHE_TTL_SEC"), "1234")
        settings_path = os.path.join(proxy_server.CONFIG_DIR, "settings.json")
        self.assertTrue(os.path.exists(settings_path))
        with open(settings_path, "r", encoding="utf-8") as fh:
            saved = json.load(fh)
        self.assertEqual(saved["CACHE_TTL_SEC"], 1234)
        self.assertFalse(saved["CLEAN_TMP_AFTER_JS"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
