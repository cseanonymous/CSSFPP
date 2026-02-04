// background.js — MV3: auto-inject + domain-from-tab + stable filenames

// ---------- helpers ----------
function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function secondLevelDomain(hostname) {
  try {
    const parts = (hostname || "").split(".");
    // Simple SLD heuristic: "www.amazon.com" -> "amazon"
    return (parts.length >= 2 ? parts[parts.length - 2] : hostname)
      .replace(/[^a-z0-9_-]/gi, "")
      .toLowerCase() || "site";
  } catch {
    return "site";
  }
}
function labelFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return secondLevelDomain(u.hostname);
  } catch {
    return "site";
  }
}

// ---------- auto-inject content.js after navigation completes ----------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && /^https?:\/\//i.test(tab.url)) {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["content.js"] },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn("[inject] executeScript error:", err.message);
        else console.log("[inject] content.js injected into", tab.url);
      }
    );
  }
});

// Keep a small queue of intended filenames to “belt & suspenders” in onDeterminingFilename
const pendingNames = [];
function pushName(name) { pendingNames.push(name); }
function popName()      { return pendingNames.shift(); }

// ---------- receive dumps from content.js & download ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "cssDump" || !msg.payload) return;

  const dump = msg.payload;
  const pageUrl = sender?.tab?.url || dump.page || "";
  const domain  = labelFromUrl(pageUrl);
  const fname   = `css_dump_${isoStamp()}_${domain}.json`;

  // data: URL tends to preserve provided filename better than blob:
  let json = "{}";
  try { json = JSON.stringify(dump, null, 2); } catch {}
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);

  // queue filename for the determining hook (extra reliability)
  pushName(fname);

  console.log("[downloads] starting", fname, "from", pageUrl);

  chrome.downloads.download(
    { url: dataUrl, filename: fname, conflictAction: "uniquify", saveAs: false },
    (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn("[downloads] failed:", err.message);
        try { sendResponse({ ok: false, error: err.message }); } catch {}
        return;
      }
      console.log("[downloads] started id=", downloadId, "filename=", fname);
      // Optionally reveal in system file manager (highlights once finished)
      try { chrome.downloads.show(downloadId); } catch {}
      try { sendResponse({ ok: true, filename: fname }); } catch {}
    }
  );

  // respond asynchronously
  return true;
});

// ---------- force our filename even for blob/data URLs ----------
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {
    const queued = popName();
    const forced = queued || `css_dump_${isoStamp()}_${labelFromUrl(item.finalUrl || item.url || "")}.json`;
    console.log("[downloads] onDeterminingFilename →", forced);
    suggest({ filename: forced, conflictAction: "uniquify" });
  } else {
    suggest();
  }
});

// ---------- log final absolute path & open folder when complete ----------
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === "complete") {
    chrome.downloads.search({ id: delta.id }, (items) => {
      const it = items && items[0];
      if (it) {
        console.log("[downloads] completed:", it.filename); // full on-disk path
        try { chrome.downloads.show(delta.id); } catch {}
      }
    });
  }
});
