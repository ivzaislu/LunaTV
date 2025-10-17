import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import proxy_server


class ProxyServerUtilsTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.addCleanup(self._restore_globals)
        self._orig_site_controller = proxy_server.SITE_CONTROLLER_FILE
        self._orig_extractor_dir = proxy_server.EXTRACTOR_DIR
        self._orig_cache_ttl = proxy_server.CACHE_TTL_SEC

    def _restore_globals(self):
        proxy_server.SITE_CONTROLLER_FILE = self._orig_site_controller
        proxy_server.EXTRACTOR_DIR = self._orig_extractor_dir
        proxy_server.CACHE_TTL_SEC = self._orig_cache_ttl

    def _write_site_controller(self, data):
        path = os.path.join(self.tmpdir.name, "site_controller.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        proxy_server.SITE_CONTROLLER_FILE = path
        return path

    def _touch_extractor(self, name):
        proxy_server.EXTRACTOR_DIR = self.tmpdir.name
        path = os.path.join(self.tmpdir.name, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("// test extractor")
        return path

    def test_pick_host_conf_prefers_wildcard(self):
        conf = {
            "default": {"script": "default.js"},
            "smotru.com": {"script": "smotru.js"},
            "*.example.com": {"script": "wildcard.js"},
        }
        chosen = proxy_server._pick_host_conf(conf, "api.example.com")
        self.assertEqual(chosen["script"], "wildcard.js")

    def test_resolve_extractors_uses_site_controller(self):
        self._touch_extractor("custom.js")
        self._write_site_controller(
            {
                "example.com": {"script": "custom.js", "timeout_sec": 15}
            }
        )
        scripts, timeout = proxy_server.resolve_extractors_and_timeout_for_url("https://example.com/watch")
        self.assertEqual(len(scripts), 1)
        self.assertTrue(scripts[0].endswith("custom.js"))
        self.assertEqual(timeout, 15)

    def test_cache_entry_is_fresh(self):
        proxy_server.CACHE_TTL_SEC = 60
        now = datetime.now(timezone.utc)
        fresh = {"timestamp": now.isoformat()}
        stale = {"timestamp": (now - timedelta(seconds=120)).isoformat()}
        self.assertTrue(proxy_server._cache_entry_is_fresh(fresh))
        self.assertFalse(proxy_server._cache_entry_is_fresh(stale))

    def test_is_m3u8_alive_head_then_get(self):
        head_resp = mock.Mock()
        head_resp.status_code = 404
        head_resp.headers = {"content-type": "text/html"}
        head_resp.close = mock.Mock()
        get_resp = mock.Mock()
        get_resp.status_code = 200
        get_resp.headers = {"content-type": "application/vnd.apple.mpegurl"}
        get_resp.iter_content = mock.Mock(return_value=iter([b"#EXTM3U\n"]))
        get_resp.close = mock.Mock()

        with mock.patch.object(proxy_server.requests, "head", return_value=head_resp) as head_mock, mock.patch.object(
            proxy_server.requests, "get", return_value=get_resp
        ) as get_mock:
            alive = proxy_server.is_m3u8_alive("https://example.com/stream.m3u8", referer="https://example.com")

        self.assertTrue(alive)
        head_mock.assert_called_once()
        get_mock.assert_called_once()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
