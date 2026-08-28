from __future__ import annotations

import gzip
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import geo_reference


class GeographyGeometryContractTest(unittest.TestCase):
    def test_national_geometry_is_pinned_valid_and_complete(self):
        path = Path(__file__).parent / "static" / "mexico-states-90a1d52.geojson"
        raw = path.read_bytes()
        payload = json.loads(raw)

        self.assertEqual(
            hashlib.sha256(raw).hexdigest(),
            "473adca8b45683fb78e7897a7f0568156b9840fbc516ce234627205e5b34eeb0",
        )
        self.assertEqual(payload["type"], "FeatureCollection")
        self.assertEqual(payload["source"]["source_commit"], "90a1d5290ede3adc147c5a2351472fd000412e72")
        self.assertEqual(payload["source"]["license"], "CC BY 3.0 IGO")
        self.assertEqual(
            payload["source"]["geometry_contract"],
            "WGS84 lon/lat · D3 clockwise exterior rings",
        )
        self.assertEqual(
            [feature["properties"]["state_code"] for feature in payload["features"]],
            [f"{state:02d}" for state in range(1, 33)],
        )
        self.assertTrue(
            all(feature["geometry"]["type"] in {"Polygon", "MultiPolygon"} for feature in payload["features"])
        )
        positions = []

        def collect(value):
            if isinstance(value, list) and len(value) >= 2 and all(
                isinstance(coordinate, (int, float)) for coordinate in value[:2]
            ):
                positions.append(value[:2])
                return
            if isinstance(value, list):
                for child in value:
                    collect(child)

        for feature in payload["features"]:
            collect(feature["geometry"]["coordinates"])
        self.assertGreater(len(positions), 1_000)
        self.assertTrue(all(-120 <= lon <= -85 and 10 <= lat <= 35 for lon, lat in positions))

        def ring_area(ring):
            return 0.5 * sum(
                left[0] * right[1] - right[0] * left[1]
                for left, right in zip(ring, ring[1:])
            )

        for feature in payload["features"]:
            geometry = feature["geometry"]
            polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
            for polygon in polygons:
                self.assertLess(ring_area(polygon[0]), 0)
                self.assertTrue(all(ring_area(hole) > 0 for hole in polygon[1:]))

    def test_postal_geometry_reads_only_the_bundled_image_reference(self):
        payload = {"type": "FeatureCollection", "features": [{"properties": {"d_codigo": "01000"}}]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            filename = geo_reference.STATE_FILES["01"]
            with gzip.open(root / f"{filename}.gz", "wt", encoding="utf-8") as target:
                json.dump(payload, target)

            with patch.object(geo_reference, "POSTAL_GEOMETRY_ROOT", root):
                geo_reference._state_geojson.cache_clear()
                self.assertEqual(geo_reference._state_geojson("01"), payload)
                with self.assertRaisesRegex(RuntimeError, "Bundled postal geometry unavailable"):
                    geo_reference._state_geojson("02")
        geo_reference._state_geojson.cache_clear()


if __name__ == "__main__":
    unittest.main()
