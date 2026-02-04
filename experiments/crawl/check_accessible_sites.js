// check_accessible_sites.js
// Usage:
//   node check_accessible_sites.js [input_file] [output_file] [failed_file]
//
// Defaults:
//   input_file  = sites.txt
//   output_file = accessible.txt
//   failed_file = failed_sites.txt
//
// Notes:
// - Uses GET (not HEAD) because many sites block/mishandle HEAD.
// - Treats any status < 500 as "reachable" (includes 3xx/4xx), since the domain is accessible.
// - Uses safe concurrency queue (no racey index++).
// - Records failures for transparency and debugging.

import fs from "fs";
import fetch from "node-fetch";
import { setTimeout as delay } from "timers/promises";

const INPUT_FILE = process.argv[2] || "sites.txt";
const OUTPUT_FILE = process.argv[3] || "accessible.txt";
const FAILED_FILE = process.argv[4] || "failed_sites.txt";

const TIMEOUT_MS = 7000;     // slightly higher than 5s to reduce false negatives
const CONCURRENCY = 30;      // 50 can be too aggressive and trigger rate limits
const PER_SITE_DELAY_MS = 50;

// Helper: fetch with timeout (lightweight GET)
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      // Small headers that help reduce bot-blocking and keep it lightweight
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CSSFPP/1.0; +https://example.invalid)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    // If the server responds (even 404/403), the domain is reachable.
    // 5xx usually indicates server-side error or transient issues.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Normalize input like "example.com", "http://example.com", "https://example.com/path"
function normalizeDomain(line) {
  const s = (line || "").trim();
  if (!s) return null;

  // If they provided a URL, extract hostname
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      return u.hostname;
    } catch {
      return null;
    }
  }

  // Otherwise assume it's a domain (strip accidental paths)
  const noProto = s.replace(/^\/+/, "");
  const cut = noProto.split(/[\/\s]/)[0];
  return cut || null;
}

// Check one domain with HTTPS -> HTTP fallback
async function checkDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, domain: null };

  const urls = [`https://${d}`, `http://${d}`];

  for (const url of urls) {
    const ok = await fetchWithTimeout(url, TIMEOUT_MS);
    if (ok) return { ok: true, domain: d };
  }
  return { ok: false, domain: d };
}

// Concurrency control using a shared queue with pop()
async function processDomains(domains) {
  const queue = [...domains]; // copy
  const accessible = [];
  const failed = [];

  let processed = 0;
  const total = queue.length;

  async function worker(workerId) {
    while (true) {
      const item = queue.shift();
      if (item === undefined) return;

      const { ok, domain } = await checkDomain(item);
      processed += 1;

      if (ok && domain) {
        accessible.push(domain);
        console.log(`✅ [${processed}/${total}] ${domain}`);
      } else {
        const label = domain || String(item).trim();
        failed.push(label);
        console.log(`❌ [${processed}/${total}] ${label}`);
      }

      if (PER_SITE_DELAY_MS > 0) await delay(PER_SITE_DELAY_MS);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);

  return { accessible, failed };
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ File not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const domains = fs
    .readFileSync(INPUT_FILE, "utf8")
    .split("\n")
    .map((d) => d.trim())
    .filter(Boolean);

  console.log(`🔍 Checking ${domains.length} domains...`);
  console.log(`⚙️  input=${INPUT_FILE} output=${OUTPUT_FILE} failed=${FAILED_FILE}`);
  console.log(`⚙️  timeout=${TIMEOUT_MS}ms concurrency=${CONCURRENCY}`);

  const { accessible, failed } = await processDomains(domains);

  // Deduplicate while preserving order
  const seen = new Set();
  const accessibleUnique = [];
  for (const d of accessible) {
    if (!seen.has(d)) {
      seen.add(d);
      accessibleUnique.push(d);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, accessibleUnique.join("\n"), "utf8");
  fs.writeFileSync(FAILED_FILE, failed.join("\n"), "utf8");

  console.log(`\n✅ Found ${accessibleUnique.length} accessible domains out of ${domains.length}.`);
  console.log(`📄 Saved accessible to ${OUTPUT_FILE}`);
  console.log(`📄 Saved failures to ${FAILED_FILE}`);
}

main().catch((e) => {
  console.error("❌ Fatal error:", e);
  process.exit(1);
});
