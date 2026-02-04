# visit_sites_playwright.py
# ------------------------------------------------------------
# pip install playwright
# python -m playwright install
# python visit_sites_playwright.py
# ------------------------------------------------------------

import json
import time
import random
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

# ---------- CONFIG (edit these) ----------
BRAVE_PATH     = r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
EXTENSION_PATH = r"C:\Users\asus\Documents\cssfpp"  # folder with manifest.json/background.js/content.js
USER_DATA_DIR  = r"C:\Users\asus\Documents\cssfpp\playwright_profile"
SITES_FILE     = "sites_main.txt"

WAIT_AFTER_NAV_SECONDS = 5.0
NAV_TIMEOUT_MS         = 30000

# Key stability knobs
WAIT_UNTIL = "domcontentloaded"   # lighter than "load"
RESTART_EVERY = 200               # restart Brave context every N sites to avoid MemoryError
PAGE_COOLDOWN_SECONDS = 0.25      # small delay between sites

# Resume logs (stored in USER_DATA_DIR)
VISITED_FILE = "visited.txt"
FAILED_FILE  = "failed.txt"

# Optional: incremental renaming so you do not scan huge Downloads at the end
INCREMENTAL_RENAME = True
# ----------------------------------------

DOMAIN_RE = re.compile(r"^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def _extract_domain(raw: str) -> str | None:
    """Normalize a line from sites.txt into a domain."""
    if not raw:
        return None
    s = raw.strip().strip('"').strip("'")
    if not s:
        return None

    # URL -> hostname
    if s.startswith(("http://", "https://")):
        try:
            host = (urlparse(s).hostname or "").lower()
            return host if DOMAIN_RE.match(host) else None
        except Exception:
            return None

    # CSV "83,opera.com"
    if "," in s:
        s = s.split(",")[-1].strip()

    # last token
    if " " in s or "\t" in s:
        s = s.split()[-1].strip()

    # strip ranks like "83.", "83-", "83:"
    s = re.sub(r"^\d+[\.\-:]", "", s).strip("/").lower()
    return s if DOMAIN_RE.match(s) else None


def load_sites(path: str) -> list[str]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(path)
    out, seen = [], set()
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        d = _extract_domain(line)
        if d and d not in seen:
            seen.add(d)
            out.append(d)
    return out


def sld_from_hostname(host: str) -> str:
    try:
        parts = (host or "").split(".")
        return (parts[-2] if len(parts) >= 2 else host).lower()
    except Exception:
        return "site"


def iso_from_epoch_ms(ms: int | float | None, fallback_path: Path | None = None) -> str:
    """ms -> 'YYYY-MM-DDTHH-MM-SSZ' (UTC). Fallback to file mtime or current time."""
    dt = None
    if isinstance(ms, (int, float)):
        try:
            dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
        except Exception:
            dt = None
    if dt is None and fallback_path is not None:
        try:
            dt = datetime.fromtimestamp(fallback_path.stat().st_mtime, tz=timezone.utc)
        except Exception:
            dt = None
    if dt is None:
        dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H-%M-%SZ")


def _try_load_json(p: Path):
    """Return parsed JSON object or None. Reads as UTF-8, ignoring errors."""
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
        if not text.lstrip().startswith(("{", "[")):
            return None
        return json.loads(text)
    except Exception:
        return None


def _uniquify(target: Path) -> Path:
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


def postprocess_rename(downloads_dir: Path, only_newer_than_epoch: float | None = None) -> int:
    """
    Scan files, parse JSON, and if it has 'page' (and optional 'timestamp'),
    rename to css_dump_<ISO>_<domain>.json.

    If only_newer_than_epoch is set, only consider files with mtime >= that timestamp.
    Returns number of renamed files.
    """
    renamed = 0
    if not downloads_dir.exists():
        return 0

    files = [p for p in downloads_dir.iterdir() if p.is_file()]
    if only_newer_than_epoch is not None:
        files = [p for p in files if p.stat().st_mtime >= only_newer_than_epoch]

    for f in files:
        data = _try_load_json(f)
        if data is None:
            continue

        page_url = data.get("page") or data.get("url")
        if not page_url:
            continue

        host = (urlparse(page_url).hostname or "").lower()
        if not DOMAIN_RE.match(host):
            continue

        domain_label = sld_from_hostname(host)
        ts_ms = data.get("timestamp")
        iso_stamp = iso_from_epoch_ms(ts_ms, fallback_path=f)

        new_name = f"css_dump_{iso_stamp}_{domain_label}.json"
        target = downloads_dir / new_name
        target = _uniquify(target)

        if target.resolve() == f.resolve():
            continue

        try:
            f.rename(target)
            renamed += 1
        except Exception:
            # ignore rename errors (file locked, etc.)
            pass

    return renamed


def _read_set(p: Path) -> set[str]:
    if not p.exists():
        return set()
    out = set()
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        s = line.strip()
        if s:
            out.add(s)
    return out


def _append_line(p: Path, line: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8", newline="\n") as f:
        f.write(line + "\n")


def launch_context(pw, profile_dir: Path, downloads_dir: Path):
    args = [
        f'--disable-extensions-except={EXTENSION_PATH}',
        f'--load-extension={EXTENSION_PATH}',
        "--no-first-run",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-features=DownloadBubbleV2",
    ]

    print("Launching Brave with your extension...")
    ctx = pw.chromium.launch_persistent_context(
        user_data_dir=str(profile_dir),
        headless=False,
        executable_path=BRAVE_PATH,
        args=args,
        viewport={"width": 1280, "height": 800},
        accept_downloads=True,
        downloads_path=str(downloads_dir),
    )
    return ctx


def main():
    profile_dir = Path(USER_DATA_DIR)
    profile_dir.mkdir(parents=True, exist_ok=True)
    downloads_dir = profile_dir / "Downloads"
    downloads_dir.mkdir(parents=True, exist_ok=True)

    visited_path = profile_dir / VISITED_FILE
    failed_path  = profile_dir / FAILED_FILE

    if not Path(EXTENSION_PATH).exists():
        raise FileNotFoundError(f"Extension not found: {EXTENSION_PATH}")
    if not Path(BRAVE_PATH).exists():
        raise FileNotFoundError(f"Brave executable not found: {BRAVE_PATH}")

    domains = load_sites(SITES_FILE)
    total_all = len(domains)
    print(f"Loaded {total_all} sites from {SITES_FILE}")

    visited = _read_set(visited_path)
    if visited:
        print(f"Resume: {len(visited)} already visited, will skip them.")

    with sync_playwright() as pw:
        ctx = None
        try:
            ctx = launch_context(pw, profile_dir, downloads_dir)

            processed = 0
            for idx, domain in enumerate(domains, start=1):
                if domain in visited:
                    continue

                # restart periodically to prevent memory growth
                if processed > 0 and (processed % RESTART_EVERY == 0):
                    print(f"\nRestarting browser context after {processed} processed sites...\n")
                    try:
                        ctx.close()
                    except Exception:
                        pass
                    ctx = launch_context(pw, profile_dir, downloads_dir)
                    time.sleep(1.0)

                url_https = f"https://{domain}"
                url_http  = f"http://{domain}"
                print(f"[{idx}/{total_all}] Visiting {url_https}")

                page = None
                start_epoch = time.time()
                loaded = False
                final_url = None
                err = None

                try:
                    page = ctx.new_page()
                    try:
                        page.goto(url_https, wait_until=WAIT_UNTIL, timeout=NAV_TIMEOUT_MS)
                        loaded = True
                        final_url = url_https
                    except Exception as e_https:
                        print(f"  HTTPS failed -> HTTP: {e_https}")
                        try:
                            page.goto(url_http, wait_until=WAIT_UNTIL, timeout=NAV_TIMEOUT_MS)
                            loaded = True
                            final_url = url_http
                        except Exception as e_http:
                            err = str(e_http)
                            print(f"  Error visiting {domain}: {e_http}")

                    if loaded:
                        time.sleep(WAIT_AFTER_NAV_SECONDS + random.uniform(0.2, 0.8))

                except Exception as e:
                    err = str(e)
                    print(f"  Unexpected error: {e}")

                finally:
                    # incremental rename of only files created during this visit
                    if INCREMENTAL_RENAME:
                        try:
                            renamed = postprocess_rename(downloads_dir, only_newer_than_epoch=start_epoch - 1.0)
                            if renamed:
                                print(f"  Renamed {renamed} new dump file(s).")
                        except Exception:
                            pass

                    if page is not None:
                        try:
                            page.close()
                        except Exception:
                            pass

                # mark visited and log failure if any
                visited.add(domain)
                _append_line(visited_path, domain)

                if not loaded or err:
                    _append_line(failed_path, f"{domain}\t{final_url or ''}\t{err or 'not_loaded'}")

                processed += 1
                time.sleep(PAGE_COOLDOWN_SECONDS + random.uniform(0.0, 0.35))

        finally:
            print("Crawl stopping. Closing browser...")
            try:
                if ctx is not None:
                    ctx.close()
            except Exception:
                pass

    # Optional: final pass rename (safe even if INCREMENTAL_RENAME already ran)
    if not INCREMENTAL_RENAME:
        print("\nPost-processing: renaming files by their JSON 'page' field...")
        renamed = postprocess_rename(downloads_dir)
        print(f"Renamed {renamed} file(s).")

    print(f"\nDone.\nVisited log: {visited_path}\nFailed log:  {failed_path}\nDownloads:   {downloads_dir}")


if __name__ == "__main__":
    main()
