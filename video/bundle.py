"""Bundle a rendered reel and all referenced audio without engine-relative paths."""
import json
from pathlib import Path
import shutil
import sys


def bundle(plan_path: Path, output: Path) -> None:
    plan = json.loads(plan_path.read_text())
    output.mkdir(parents=True, exist_ok=True)
    for segment in plan["segments"]:
        for media in segment["plan"].get("media", []):
            relative = Path(media["path"])
            source = (plan_path.parent / relative).resolve()
            if str(relative).startswith("../../assets/"):
                relative = Path("media/sfx") / relative.relative_to("../../assets")
            elif relative.is_absolute() or ".." in relative.parts:
                raise ValueError(f"Unexpected media path: {relative}")
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            media["path"] = relative.as_posix()
    (output / plan_path.name).write_text(json.dumps(plan, indent=2) + "\n")
    shutil.copy2(plan_path.parent / "media.lock.json", output / "media.lock.json")


if __name__ == "__main__":
    bundle(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
