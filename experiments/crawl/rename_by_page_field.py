# rename_by_page_field.py
# Renames files in a downloads folder based on JSON content:
# looks for {"page": "<url>", "timestamp": <ms?>} and renames to
# css_dump_<ISO>_<domain>.json (uniquifying if needed).

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

# -------- CONFIG --------
DOWNLOADS_DIR = Path(r"C:\Users\asus\Documents\cssfpp\playwright_profile\Downloads")
# ------------------------

# Accept domains like example.com, sub.domain.co.uk (simple sanity check)
DOMAIN_RE = re.compile(r"^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

def extract_domain(url: str) -> str | None:
    try:
        host = (urlparse(url).hostname or "").lower()
        return host if DOMAIN_RE.match(host) else None
    except Exception:
        return None

def sld(hostname: str) -> str:
    try:
        parts = hostname.split(".")
        return (parts[-2] if len(parts) >= 2 else hostname).lower()
    except Exception:
        return "site"

def iso_from_timestamp_ms(ts_ms: int | float | None, fallback_path: Path) -> str:
    """Return 'YYYY-MM-DDTHH-MM-SSZ' in UTC. Prefer JSON timestamp (ms); fallback to file mtime."""
    dt: datetime | None = None
    if isinstance(ts_ms, (int, float)):
        try:
            dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
        except Exception:
            dt = None
    if dt is None:
        try:
            dt = datetime.fromtimestamp(fallback_path.stat().st_mtime, tz=timezone.utc)
        except Exception:
            dt = datetime.now(tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H-%M-%SZ")

def try_load_json(p: Path):
    """
    Try to parse file as JSON.
    Returns (obj or None). Reads text as UTF-8 with errors ignored
    so GUID-named files without extension still parse if they are JSON.
    """
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
        # Fast reject for obvious non-JSON
        stripped = text.lstrip()
        if not stripped.startswith(("{", "[")):
            return None
        return json.loads(text)
    except Exception:
        return None

def uniquify(target: Path) -> Path:
    """Append _1, _2, ... if target exists."""
    if not target.exists():
        return target
    base = target.stem
    i = 1
    while True:
        candidate = target.with_name(f"{base}_{i}{target.suffix}")
        if not candidate.exists():
            return candidate
        i += 1

def main():
    if not DOWNLOADS_DIR.exists():
        print(f"Folder not found: {DOWNLOADS_DIR}")
        return

    files = [p for p in DOWNLOADS_DIR.iterdir() if p.is_file()]
    if not files:
        print(f"No files found in {DOWNLOADS_DIR}")
        return

    renamed, skipped = 0, 0
    for f in files:
        data = try_load_json(f)
        if data is None:
            skipped += 1
            continue

        page_url = data.get("page") or data.get("url")
        if not page_url:
            skipped += 1
            continue

        host = extract_domain(page_url)
        if not host:
            skipped += 1
            continue

        label = sld(host)
        iso = iso_from_timestamp_ms(data.get("timestamp"), f)
        new_name = f"css_dump_{iso}_{label}.json"

        target = DOWNLOADS_DIR / new_name
        target = uniquify(target)

        # If file already has the correct name, skip
        if f.resolve() == target.resolve():
            continue

        try:
            f.rename(target)
            print(f"Renamed: {f.name} -> {target.name}")
            renamed += 1
        except Exception as e:
            print(f"Could not rename {f.name}: {e}")
            skipped += 1

    print(f"\n✅ Done. Renamed {renamed} file(s), skipped {skipped}.")

if __name__ == "__main__":
    main()
