from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from asset_release import (
    asset_etag,
    build_asset_manifest,
    etag_matches,
    manifest_bytes,
    release_asset_bytes,
    release_revision,
    version_page,
)


class AssetReleaseContractTest(unittest.TestCase):
    def test_one_manifest_revision_covers_every_static_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app.js").write_text("import './shared.js';")
            (root / "shared.js").write_text("export const value = 1;")
            (root / "favicon.svg").write_text('<svg viewBox="0 0 1 1"></svg>')
            (root / "map.geojson").write_text('{"type":"FeatureCollection","features":[]}')

            manifest = build_asset_manifest(root)
            revision = release_revision(manifest)

            self.assertEqual(
                sorted(manifest),
                ["app.js", "favicon.svg", "map.geojson", "shared.js"],
            )
            self.assertEqual(len(revision), 12)
            payload = manifest_bytes(manifest, revision).decode()
            self.assertIn(f'"revision":"{revision}"', payload)
            self.assertIn('"/assets/map.geojson"', payload)
            self.assertIn(f'"url":"/assets/map.geojson?v={revision}"', payload)
            self.assertIn(f'"url":"/assets/favicon.svg?v={revision}"', payload)

            (root / "map.geojson").write_text('{"type":"FeatureCollection","features":[{}]}')
            self.assertNotEqual(release_revision(build_asset_manifest(root)), revision)

    def test_page_and_transitive_module_references_share_revision(self):
        revision = "123456789abc"
        page = version_page(
            '<html><head><link rel="icon" href="/assets/favicon.svg"></head>'
            '<body><script type="module" src="/assets/app.js"></script></body></html>',
            revision,
        )
        self.assertIn(f'<meta name="dpp-asset-revision" content="{revision}"', page)
        self.assertIn(f'/assets/app.js?v={revision}', page)
        self.assertIn(f'/assets/favicon.svg?v={revision}', page)

        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "app.js"
            script.write_text(
                "import './shared.js'; const geometry = '/assets/map.geojson';"
            )
            body = release_asset_bytes(script, revision).decode()
            self.assertIn(f"./shared.js?v={revision}", body)
            self.assertIn(f"/assets/map.geojson?v={revision}", body)

            vendor = Path(directory) / "vendor" / "library.js"
            vendor.parent.mkdir()
            vendor.write_text("const example = '/assets/map.geojson';")
            self.assertEqual(
                release_asset_bytes(vendor, revision),
                b"const example = '/assets/map.geojson';",
            )

    def test_stable_etag_validator_accepts_exact_or_wildcard(self):
        etag = asset_etag(b"release asset")
        self.assertTrue(etag.startswith('W/"'))
        self.assertTrue(etag_matches(etag, etag))
        self.assertTrue(etag_matches(f'"other", {etag}', etag))
        self.assertTrue(etag_matches("*", etag))
        self.assertFalse(etag_matches('W/"other"', etag))


if __name__ == "__main__":
    unittest.main()
