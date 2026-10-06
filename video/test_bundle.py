import json
from pathlib import Path
import tempfile
import unittest

from bundle import bundle


class BundleTests(unittest.TestCase):
    def test_narration_and_sounds_are_portable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene = root / "engine/scenes/opencode-ci"
            scene.mkdir(parents=True)
            (scene / "media").mkdir()
            (scene / "media/voice.mp3").write_bytes(b"voice")
            sounds = root / "engine/assets/effects"
            sounds.mkdir(parents=True)
            (sounds / "tick.wav").write_bytes(b"tick")
            lock = '{"resources": {}}\n'
            (scene / "media.lock.json").write_text(lock)
            plan = {"segments": [{"plan": {"media": [
                {"path": "media/voice.mp3", "gainDb": 0},
                {"path": "../../assets/effects/tick.wav", "gainDb": -20},
            ]}}]}
            plan_path = scene / "opencode-ci.plan.json"
            plan_path.write_text(json.dumps(plan))
            output = root / "output"
            bundle(plan_path, output)
            bundled = json.loads((output / plan_path.name).read_text())
            self.assertEqual(bundled["segments"][0]["plan"]["media"], [
                {"path": "media/voice.mp3", "gainDb": 0},
                {"path": "media/sfx/effects/tick.wav", "gainDb": -20},
            ])
            self.assertEqual((output / "media/voice.mp3").read_bytes(), b"voice")
            self.assertEqual((output / "media/sfx/effects/tick.wav").read_bytes(), b"tick")
            self.assertEqual((output / "media.lock.json").read_text(), lock)
            self.assertEqual(json.loads(plan_path.read_text()), plan)


if __name__ == "__main__":
    unittest.main()
