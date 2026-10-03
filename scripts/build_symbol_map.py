import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fno_analyzer.application import Application
from fno_analyzer.config import load_settings


def main() -> None:
    settings = load_settings()
    application = Application(settings)
    if not application.aoc.configured:
        raise SystemExit("AOC is not configured")
    result = application.dhan_map(refresh=True)
    print(f"mapped={len(result.get('mapped', []))} unmapped={len(result.get('unmapped', []))}")
    print(f"saved={settings['map_path']}")


if __name__ == "__main__":
    main()
