from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
M3U_DIR = ROOT / "m3u"


class M3UIntegrityTests(unittest.TestCase):
    def test_playlists_do_not_use_legacy_proxy_port(self):
        failures = []
        for path in sorted(M3U_DIR.glob("*.m3u")):
            text = path.read_text(encoding="utf-8")
            if "127.0.0.1:5000/stream/" in text or "localhost:5000/stream/" in text:
                failures.append(path.name)
        self.assertEqual([], failures, f"Legacy :5000 proxy URLs remain in: {failures}")

    def test_playlists_do_not_repeat_exact_stream_urls(self):
        failures = {}
        for path in sorted(M3U_DIR.glob("*.m3u")):
            urls = [
                line.strip()
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip().startswith(("http://", "https://"))
            ]
            seen = set()
            duplicates = []
            for url in urls:
                if url in seen and url not in duplicates:
                    duplicates.append(url)
                seen.add(url)
            if duplicates:
                failures[path.name] = duplicates
        self.assertEqual({}, failures, f"Duplicate stream URLs found: {failures}")


if __name__ == "__main__":
    unittest.main()
