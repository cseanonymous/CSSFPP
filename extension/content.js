// ====================================================================
// content.js — CSS fingerprinting detector (값 에코 기반 확인 포함) - obfuscation-aware + FP likelihood scoring
// - Tier 1 (echo-confirmed): 기존과 동일. 소스 토큰이 싱크 URL에 에코될 때만 연결 확정
// - Tier 2 (dependency-confirmed): URL 에코가 없어도 "고신뢰 조건부 소스"가 sink를 감싸면 연결 후보로 기록
//   (단, geometry/container/import-condition 등 저신뢰 소스는 Tier 2 제외)
// - NEW: False-positive mitigation via likelihood scoring
//   · Tier 1 -> likely fingerprinting (strong)
//   · Tier 2 only -> "conditional fetch observed" 기본, 조합/3rd-party/복잡도 기준 충족 시에만
//     potential/likely fingerprinting 로 승격
// - NEW: combo metrics (distinct attributes, distinct semantic groups, distinct sink hosts, third-party sinks)
// - Sink: url(...), @import url(...)/"..."
// - Source-Sink 연결: 같은 규칙 + 조상 그룹까지 인정
// ====================================================================

if (!window.__cssLoggerInjected) {
  window.__cssLoggerInjected = true;

  const MAX_RULES_PER_SHEET = 1500;
  const MAX_TOTAL_RULES = 8000;
  const URL_SNIPPET_LEN = 1600;

  // ---------------- helpers ----------------
  const short = (s, n = 240) => (s && s.length > n ? s.slice(0, n) + "..." : (s || ""));
  const lower = (s) => (s || "").toLowerCase();

  const MIN_TOKEN_LEN = 3; // ignore alpha tokens shorter than this unless numeric-prefixed (e.g., 2dppx)

  function isUsefulToken(tok) {
    if (!tok) return false;
    tok = String(tok).trim();
    if (!tok) return false;
    if (/^\d/.test(tok)) return true; // numeric or unit-like tokens are allowed
    if (tok.length < MIN_TOKEN_LEN) return false; // short alphabetic tokens are noisy
    return true;
  }

  function getRuleTypeNameByNumber(t) {
    const map = {};
    if (typeof CSSRule !== "undefined") {
      map[CSSRule.STYLE_RULE] = "CSSStyleRule";
      map[CSSRule.IMPORT_RULE] = "CSSImportRule";
      map[CSSRule.MEDIA_RULE] = "CSSMediaRule";
      map[CSSRule.FONT_FACE_RULE] = "CSSFontFaceRule";
      map[CSSRule.SUPPORTS_RULE] = "CSSSupportsRule";
      map[CSSRule.PAGE_RULE] = "CSSPageRule";
      map[CSSRule.KEYFRAMES_RULE] = "CSSKeyframesRule";
    }
    return map[t] || "CSSRule";
  }

  function ruleTypeName(rule) {
    try {
      if (typeof rule.type === "number") {
        const name = getRuleTypeNameByNumber(rule.type);
        if (name !== "CSSRule") return name;
      }
      return (rule.constructor && rule.constructor.name) || "CSSRule";
    } catch {
      return "CSSRule";
    }
  }

  function getConditionText(rule) {
    try {
      if (rule.conditionText) return rule.conditionText; // @media/@supports/@container
      if (rule.media && rule.media.mediaText) return rule.media.mediaText; // CSSImportRule media
    } catch {}
    return "";
  }

  function extractUrlStrings(text) {
    const urls = [];
    if (!text) return urls;
    const urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    let m;
    while ((m = urlRegex.exec(text)) !== null) urls.push(m[1]);
    return urls;
  }

  function extractImportUrls(text) {
    const urls = [];
    if (!text) return urls;
    const importRegex = /@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])/gi;
    let m;
    while ((m = importRegex.exec(text)) !== null) urls.push(m[1] || m[2]);
    return urls;
  }

  // Safe URL parsing helpers
  function safeUrlToHostname(u) {
    try {
      const urlObj = new URL(u, location.href);
      return lower(urlObj.hostname || "");
    } catch {
      return "";
    }
  }

  // Naive eTLD+1 (good enough for measurement; avoid heavy PSL dependency in content script)
  function naiveETLD1(hostname) {
    hostname = lower(hostname || "");
    if (!hostname) return "";
    if (hostname === "localhost") return "localhost";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname; // IP literal
    const parts = hostname.split(".").filter(Boolean);
    if (parts.length <= 2) return hostname;

    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    const thirdLast = parts[parts.length - 3];

    const common2Level = new Set(["co", "com", "net", "org", "ac", "gov", "edu"]);
    const ccTLD = last.length === 2;
    if (ccTLD && common2Level.has(secondLast) && thirdLast) {
      return `${thirdLast}.${secondLast}.${last}`;
    }
    return `${secondLast}.${last}`;
  }

  function isThirdPartySink(pageHost, sinkHost) {
    const p = naiveETLD1(pageHost);
    const s = naiveETLD1(sinkHost);
    if (!p || !s) return false;
    return p !== s;
  }

  // Heuristic for "identifier-like" URLs (cache busters / per-client IDs)
  function looksLikeIdentifierUrl(u) {
    try {
      const urlObj = new URL(u, location.href);
      const q = urlObj.search || "";
      const path = urlObj.pathname || "";
      const full = (path + q).toLowerCase();

      // Long hex/base64-ish segments
      if (/[0-9a-f]{16,}/i.test(full)) return true;
      if (/[a-z0-9_-]{24,}/i.test(full) && /[a-z]/i.test(full) && /\d/.test(full)) return true;

      // Common cache-busting params
      if (/(^|[?&])(cb|cachebust|cache_bust|_cb|_t|t|ts|timestamp|rnd|rand|nonce|sig|token|id|uid)=/i.test(q)) return true;

      // Many digits in query (rough)
      const digits = (q.match(/\d/g) || []).length;
      if (digits >= 18) return true;

      return false;
    } catch {
      return false;
    }
  }

  // ---------------- source keyword dictionaries ----------------
  const MEDIA_SOURCES = [
    { key: "prefers-color-scheme", group: "user preference", claim: "color scheme (light/dark)" },
    { key: "forced-colors", group: "user preference", claim: "forced colors (OS high contrast)" },
    { key: "prefers-reduced-motion", group: "user preference", claim: "reduced motion preference" },
    { key: "prefers-contrast", group: "user preference", claim: "contrast preference" },
    { key: "prefers-reduced-data", group: "user preference", claim: "reduced data preference" },
    { key: "prefers-reduced-transparency", group: "user preference", claim: "reduced transparency preference" },
    { key: "inverted-colors", group: "user preference", claim: "inverted colors (OS color inversion)" },

    { key: "pointer", group: "input capability", claim: "pointer accuracy" },
    { key: "any-pointer", group: "input capability", claim: "any-pointer accuracy" },
    { key: "hover", group: "input capability", claim: "hover capability" },
    { key: "any-hover", group: "input capability", claim: "any-hover capability" },

    { key: "color-gamut", group: "display capability", claim: "color gamut" },
    { key: "dynamic-range", group: "display capability", claim: "HDR dynamic range" },
    { key: "monochrome", group: "display capability", claim: "monochrome bit depth" },
    { key: "resolution", group: "display capability", claim: "pixel density (dpi/dppx)" },
    { key: "device-pixel-ratio", group: "display capability", claim: "device pixel ratio (alias)" },

    { key: "display-mode", group: "app environment", claim: "PWA display mode" },
    { key: "environment-blending", group: "app environment", claim: "environment blending mode" }
  ];

  const MEDIA_SOURCES_GEOMETRY = [
    { key: "width", group: "geometry", claim: "viewport width" },
    { key: "height", group: "geometry", claim: "viewport height" },
    { key: "aspect-ratio", group: "geometry", claim: "viewport aspect ratio" },
    { key: "orientation", group: "geometry", claim: "screen orientation" },
    { key: "device-width", group: "geometry", claim: "device width (deprecated)" },
    { key: "device-height", group: "geometry", claim: "device height (deprecated)" }
  ];

  const SUPPORTS_SOURCES = [
    { key: "accent-color", group: "engine feature", claim: "accent-color support" },
    { key: "text-wrap: balance", group: "layout capability", claim: "text-wrap balance support" },
    { key: "contain:", group: "layout capability", claim: "contain property support" },

    { key: "selector(:has", group: "selector capability", claim: ":has() selector support" },
    { key: "backdrop-filter", group: "graphics pipeline", claim: "backdrop-filter support" },
    { key: "anchor-name", group: "layout capability", claim: "anchor positioning support" },
    { key: "view-timeline", group: "timeline capability", claim: "view timeline support" },
    { key: "animation-timeline", group: "timeline capability", claim: "animation timeline support" },
    { key: "timeline-scope", group: "timeline capability", claim: "timeline scope support" },
    { key: "font-variation-settings", group: "font capability", claim: "variable font support" },
    { key: "color(display-p3", group: "color capability", claim: "display-p3 color function support" },
    { key: "scrollbar-gutter", group: "engine feature", claim: "scrollbar-gutter support" },
    { key: "scrollbar-width", group: "engine feature", claim: "scrollbar-width support" },
    { key: "scrollbar-color", group: "engine feature", claim: "scrollbar-color support" },
    { key: "-webkit-appearance", group: "engine hint", claim: "WebKit-specific appearance" },
    { key: "-moz-appearance", group: "engine hint", claim: "Gecko-specific appearance" }
  ];

  const CONTAINER_SOURCES = [
    { key: "inline-size", group: "container query", claim: "container inline-size" },
    { key: "block-size", group: "container query", claim: "container block-size" },
    { key: "style(", group: "container query", claim: "container style() query" }
  ];

  const FONT_LOCAL_TOKEN = "local(";
  const IMPORT_MEDIA_KEYS = MEDIA_SOURCES.map((m) => m.key).concat(MEDIA_SOURCES_GEOMETRY.map((m) => m.key));

  // ---------------- risk scoring ----------------
  function riskFor(group) {
    switch (group) {
      case "fonts": return 4;
      case "user preference": return 3;
      case "display capability": return 3;
      case "input capability": return 2;
      case "selector capability": return 2;
      case "graphics pipeline": return 2;
      case "timeline capability": return 2;
      case "layout capability": return 2;
      case "font capability": return 2;
      case "color capability": return 2;
      case "engine feature": return 1;
      case "engine hint": return 1;
      case "app environment": return 1;
      case "geometry": return 1;
      case "container query": return 1;
      case "font coverage": return 1;
      case "import condition": return 1;
      default: return 1;
    }
  }

  function explanationFor(group, keyword, claim) {
    switch (group) {
      case "fonts":
        return "Local font presence reveals installed fonts and can strongly identify a device.";
      case "user preference":
        return "Reveals OS/user accessibility or UI preferences.";
      case "display capability":
        return "Reveals screen/output characteristics (gamut, HDR, pixel density).";
      case "input capability":
        return "Reveals input device capability (touch vs mouse) and pointer precision.";
      case "selector capability":
      case "graphics pipeline":
      case "timeline capability":
      case "layout capability":
      case "font capability":
      case "color capability":
        return "Reveals browser engine/version capability.";
      case "engine feature":
      case "engine hint":
        return "Hints at browser engine family.";
      case "geometry":
        return "Reflects viewport/window state; low entropy unless the condition value is exfiltrated.";
      case "container query":
        return "Reflects layout container size; low entropy unless the condition value is exfiltrated.";
      default:
        return `Reveals ${claim || keyword || group}`;
    }
  }

  // ---------------- token extraction ----------------
  function tokensFromMediaCondition(cond) {
    const t = new Set();
    if (!cond) return [];
    const c = lower(cond);

    for (const m of c.matchAll(/\(\s*([-\w]+)\s*:\s*([^)]+?)\s*\)/g)) {
      const feature = (m[1] || "").trim();
      const value = (m[2] || "").trim();
      if (isUsefulToken(feature)) t.add(feature);
      const parts = value.split(/[\s/,+]+/);
      for (let part of parts) {
        part = part.replace(/[^a-z0-9.+-]/g, "");
        if (isUsefulToken(part)) t.add(part);
      }
    }

    for (const m of c.matchAll(/(-?\d+(?:\.\d+)?)(\s*)(px|dppx|dpi|dpcm|rem|em|ch|vw|vh|vi|vb)?/g)) {
      const num = m[1];
      const unit = (m[3] || "").trim();
      if (num) t.add(num);
      if (num && unit) t.add(num + unit);
    }

    [
      "min-width","max-width","width","min-height","max-height","height",
      "aspect-ratio","orientation","resolution","device-pixel-ratio","monochrome",
      "inline-size","block-size","pointer","any-pointer","hover","any-hover",
      "prefers-color-scheme","prefers-contrast","prefers-reduced-motion","prefers-reduced-data",
      "color-gamut","dynamic-range","display-mode","environment-blending"
    ].forEach((fn) => { if (c.includes(fn)) t.add(fn); });

    if (c.includes("landscape")) t.add("landscape");
    if (c.includes("portrait")) t.add("portrait");
    for (const m of c.matchAll(/(\d+)\s*\/\s*(\d+)/g)) t.add(`${m[1]}/${m[2]}`);

    return Array.from(t);
  }

  function tokensFromContainerCondition(cond) {
    const t = new Set();
    if (!cond) return [];
    const c = lower(cond);

    ["inline-size","block-size","style("].forEach((k) => { if (c.includes(k)) t.add(k); });

    for (const m of c.matchAll(/(-?\d+(?:\.\d+)?)(\s*)(px|rem|em|ch|vw|vh|vi|vb)?/g)) {
      const num = m[1];
      const unit = (m[3] || "").trim();
      if (num) t.add(num);
      if (num && unit) t.add(num + unit);
    }

    for (const m of c.matchAll(/style\(\s*([^)]+)\)/g)) {
      const inside = m[1] || "";
      for (const id of inside.split(/[\s:;,/()+]+/)) {
        const tok = id.replace(/[^a-z0-9.+-]/g, "");
        if (isUsefulToken(tok)) t.add(tok);
      }
    }

    return Array.from(t);
  }

  function tokensFromSupports(hay, keyword) {
    const t = new Set();
    const c = lower(hay || "");
    if (keyword && isUsefulToken(keyword)) t.add(lower(keyword));

    const head = c.match(/([-\w]+)\s*[:(]/);
    if (head && isUsefulToken(head[1])) t.add(head[1]);

    for (const m of c.matchAll(/\(([^)]+)\)/g)) {
      const inside = m[1] || "";
      for (const id of inside.split(/[\s,/:;+]+/)) {
        const tok = id.replace(/[^a-z0-9.+-]/g, "");
        if (isUsefulToken(tok)) t.add(tok);
      }
    }
    return Array.from(t);
  }

  function tokensFromUnicodeRange(cssText) {
    const t = new Set();
    const c = lower(cssText || "");
    for (const m of c.matchAll(/u\+[0-9a-f?-]+(?:-[0-9a-f?-]+)?/gi)) {
      const tok = (m[0] || "").toLowerCase();
      if (isUsefulToken(tok)) t.add(tok);
    }
    return Array.from(t);
  }

  function urlEchoesTokens(url, tokens) {
    if (!url || !tokens || !tokens.length) return false;
    const u = lower(url);
    for (const tok of tokens) {
      if (!tok) continue;
      if (/^[a-z]+$/i.test(tok)) {
        const pattern = new RegExp(`(^|[\\W_])${tok}($|[\\W_])`, "i");
        if (pattern.test(u)) return true;
      } else {
        if (u.includes(tok)) return true;
      }
    }
    return false;
  }

  // ---------------- Tier 2 gating ----------------
  function eligibleForTier2(sourceObj) {
    if (!sourceObj) return false;
    const g = sourceObj.semanticGroup;
    if (!g) return false;
    if (g === "geometry") return false;
    if (g === "container query") return false;
    if (g === "import condition") return false;
    return true;
  }

  // ---------------- identify sources within a rule ----------------
  function identifySourceKeywords(rule) {
    const out = [];
    try {
      const type = ruleTypeName(rule);
      const cssText = lower(rule.cssText || "");
      const cond = lower(getConditionText(rule) || "");

      // @media
      if (type === "CSSMediaRule" || /@media\b/i.test(cssText)) {
        for (const m of MEDIA_SOURCES) {
          if (cond.includes(m.key)) {
            out.push({
              category: "@media",
              keyword: m.key,
              semanticGroup: m.group,
              claim: m.claim,
              excerpt: short(cond, 220),
              requiresEcho: true,
              echoTokens: tokensFromMediaCondition(cond)
            });
          }
        }
        for (const g of MEDIA_SOURCES_GEOMETRY) {
          if (cond.includes(g.key)) {
            out.push({
              category: "@media",
              keyword: g.key,
              semanticGroup: g.group,
              claim: g.claim,
              excerpt: short(cond, 220),
              requiresEcho: true,
              echoTokens: tokensFromMediaCondition(cond)
            });
          }
        }
      }

      // @supports
      if (type === "CSSSupportsRule" || /@supports\b/i.test(cssText)) {
        const hay = cond || cssText;
        for (const s of SUPPORTS_SOURCES) {
          if ((hay || "").includes(s.key)) {
            out.push({
              category: "@supports",
              keyword: s.key,
              semanticGroup: s.group,
              claim: s.claim,
              excerpt: short(hay, 220),
              requiresEcho: true,
              echoTokens: tokensFromSupports(hay, s.key)
            });
          }
        }
        if (!SUPPORTS_SOURCES.some((s) => (cond || cssText).includes(s.key))) {
          const genericTokens = tokensFromSupports(hay, "");
          if (genericTokens.length) {
            out.push({
              category: "@supports",
              keyword: "supports(generic)",
              semanticGroup: "engine feature",
              claim: "generic supports probe",
              excerpt: short(hay, 220),
              requiresEcho: true,
              echoTokens: genericTokens
            });
          }
        }
      }

      // @container
      const isContainer = type.toLowerCase().includes("container") || cssText.includes("@container");
      if (isContainer) {
        const hay = cond || cssText;
        for (const c of CONTAINER_SOURCES) {
          if ((hay || "").includes(c.key)) {
            out.push({
              category: "@container",
              keyword: c.key,
              semanticGroup: c.group,
              claim: c.claim,
              excerpt: short(hay, 220),
              requiresEcho: true,
              echoTokens: tokensFromContainerCondition(hay)
            });
          }
        }
      }

      // @font-face local(...)
      if (type === "CSSFontFaceRule" || /@font-face\b/i.test(cssText)) {
        if (cssText.includes(FONT_LOCAL_TOKEN)) {
          const localRegex = /local\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
          let m;
          while ((m = localRegex.exec(cssText)) !== null) {
            const fontName = m[1] || "(local)";
            out.push({
              category: "@font-face",
              keyword: "local(",
              semanticGroup: "fonts",
              claim: `local font presence probe (${fontName})`,
              excerpt: short(cssText, 220),
              requiresEcho: true,
              echoTokens: [lower(fontName)]
            });
          }
        }
      }

      // @font-face unicode-range when local()+url() exist
      if (type === "CSSFontFaceRule" || /@font-face\b/i.test(cssText)) {
        const hasUnicodeRange = cssText.includes("unicode-range");
        const hasLocal = cssText.includes("local(");
        const hasUrl = /url\(\s*['"][^'"]+['"]\s*\)/i.test(cssText);
        if (hasUnicodeRange && hasLocal && hasUrl) {
          out.push({
            category: "@font-face",
            keyword: "unicode-range",
            semanticGroup: "font coverage",
            claim: "unicode-range + local() may reveal local font coverage",
            excerpt: short(cssText, 220),
            requiresEcho: true,
            echoTokens: tokensFromUnicodeRange(cssText)
          });
        }
      }

      // @import conditional media
      if (type === "CSSImportRule" || /@import\b/i.test(cssText)) {
        let mediaTxt = "";
        try {
          if (rule.media && rule.media.mediaText) mediaTxt = lower(rule.media.mediaText || "");
        } catch {}
        const hay = mediaTxt || "";
        for (const key of IMPORT_MEDIA_KEYS) {
          if ((hay || "").includes(key)) {
            out.push({
              category: "@import",
              keyword: key,
              semanticGroup: "import condition",
              claim: `conditional import via ${key}`,
              excerpt: short(hay, 220),
              requiresEcho: true,
              echoTokens: tokensFromMediaCondition(hay)
            });
          }
        }
      }
    } catch {}

    const seen = new Set();
    return out.filter((x) => {
      const id = `${x.category}::${x.keyword}::${x.claim}::${x.excerpt}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  // ---------------- walk rules (ancestor-aware) ----------------
  function walkRulesToList(rules, sheetHref, groupContext, outList, ancestorSources, totalCountBox) {
    if (!rules) return outList;
    outList = outList || [];
    ancestorSources = ancestorSources || [];

    for (let i = 0; i < rules.length; i++) {
      if (outList.length >= MAX_RULES_PER_SHEET) break;
      if (totalCountBox.count >= MAX_TOTAL_RULES) break;

      const rule = rules[i];
      const type = ruleTypeName(rule);
      const selector = "selectorText" in rule && rule.selectorText ? rule.selectorText : "";
      const cssText = rule.cssText || "";
      const groupCond = getConditionText(rule);

      const entry = {
        type,
        selector,
        cssText: short(cssText, URL_SNIPPET_LEN),
        urls: [],
        group: groupContext || groupCond || "",
        sources: [],
        sinks: [],
        inheritedSources: ancestorSources
      };

      const srcs = identifySourceKeywords(rule);
      if (srcs.length) {
        entry.sources = srcs.map((s) => ({
          reason: "keyword_match",
          category: s.category,
          keyword: s.keyword,
          semanticGroup: s.semanticGroup,
          claim: s.claim,
          excerpt: s.excerpt,
          requiresEcho: !!s.requiresEcho,
          echoTokens: s.echoTokens || []
        }));
      }

      const sinkUrls = (cssText && extractUrlStrings(lower(cssText))).concat(
        type === "CSSImportRule" ? extractImportUrls(lower(cssText)) : []
      );
      if (sinkUrls.length > 0) {
        entry.urls = sinkUrls.slice();
        entry.sinks.push({ reason: "url_sink", urls: sinkUrls.slice() });
      }

      outList.push(entry);
      totalCountBox.count++;

      const mergedAncestorSources = [].concat(ancestorSources || []).concat(entry.sources || []);

      try {
        if (rule.cssRules && rule.cssRules.length) {
          walkRulesToList(
            rule.cssRules,
            sheetHref,
            groupCond || groupContext || "",
            outList,
            mergedAncestorSources,
            totalCountBox
          );
        }
      } catch {}
    }

    return outList;
  }

  // ---------------- likelihood scoring helpers ----------------
  function computeDependencyLikelihoodMetrics(dump, associations) {
    const attrs = new Set();
    const semGroups = new Set();
    const sinkHosts = new Set();

    const thirdPartySinkHosts = new Set();
    const identifierLikeSinkHosts = new Set();

    let thirdPartySinks = 0;
    let identifierLikeSinks = 0;

    for (const a of associations) {
      if (!a) continue;

      if (a.sinkHost) sinkHosts.add(a.sinkHost);

      const is3p = !!a.isThirdParty;
      const isId = !!a.identifierLike;

      if (is3p) {
        thirdPartySinks++;
        if (a.sinkHost) thirdPartySinkHosts.add(a.sinkHost);
      }
      if (isId) {
        identifierLikeSinks++;
        if (a.sinkHost) identifierLikeSinkHosts.add(a.sinkHost);
      }

      const ms = a.matchedSources || [];
      for (const s of ms) {
        if (!s) continue;
        if (s.keyword) attrs.add(String(s.keyword));
        if (s.semanticGroup) semGroups.add(String(s.semanticGroup));
      }
    }

    return {
      numDistinctAttributes: attrs.size,
      numDistinctSemanticGroups: semGroups.size,
      numDistinctSinkHosts: sinkHosts.size,
      numThirdPartySinks: thirdPartySinks,
      numDistinctThirdPartySinkHosts: thirdPartySinkHosts.size,
      numIdentifierLikeSinks: identifierLikeSinks,
      numDistinctIdentifierLikeSinkHosts: identifierLikeSinkHosts.size
    };
  }

  function scoreDependencyLikelihood(m) {
    let score = 0;

    const dAttrs = m.numDistinctAttributes || 0;
    const dGroups = m.numDistinctSemanticGroups || 0;
    const dSinkHosts = m.numDistinctSinkHosts || 0;

    const n3p = m.numThirdPartySinks || 0;
    const nId = m.numIdentifierLikeSinks || 0;

    if (dAttrs >= 2) score += 2;
    if (dAttrs >= 4) score += 2;

    if (dGroups >= 2) score += 2;
    if (dGroups >= 3) score += 2;

    if (dSinkHosts >= 2) score += 1;
    if (dSinkHosts >= 4) score += 1;

    if (n3p >= 1) score += 2;
    if (n3p >= 3) score += 1;

    if (nId >= 1) score += 3;
    if (nId >= 3) score += 2;

    return score;
  }

  function labelFromScore(score) {
    if (score >= 9) return "likely fingerprinting (dependency-confirmed)";
    if (score >= 5) return "potential fingerprinting (dependency-confirmed)";
    return "conditional fetch observed (dependency-confirmed)";
  }

  // ---------------- main ----------------
  (function run() {
    const dump = {
      page: location.href,
      timestamp: Date.now(),
      pageHost: safeUrlToHostname(location.href),
      pageETLD1: naiveETLD1(safeUrlToHostname(location.href)),
      sheets: [],
      inaccessible: []
    };

    const totalCountBox = { count: 0 };

    for (let s = 0; s < document.styleSheets.length; s++) {
      const sheet = document.styleSheets[s];
      const rec = { href: sheet.href || "(inline <style>)", rules: 0, rulesList: [] };
      try {
        if (sheet.cssRules) {
          rec.rulesList = walkRulesToList(sheet.cssRules, rec.href, "", [], [], totalCountBox);
          rec.rules = rec.rulesList.length;
        } else {
          rec.rules = 0;
        }
      } catch {
        rec.rules = "inaccessible";
        dump.inaccessible.push(sheet.href || "(inline)");
      }
      dump.sheets.push(rec);
      if (totalCountBox.count >= MAX_TOTAL_RULES) break;
    }

    dump.styleTags = document.querySelectorAll("style").length;
    dump.inlineStyleCount = document.querySelectorAll("[style]").length;

    // ---------------- source-sink linking (Tier 1 + Tier 2) ----------------
    dump.associations = [];
    const claimDetailsMap = new Map();

    let tier1Count = 0;
    let tier2Count = 0;

    for (const sheetRec of dump.sheets) {
      const list = sheetRec.rulesList || [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r.sinks || !r.sinks.length) continue;

        const sinkUrls = r.sinks[0].urls && r.sinks[0].urls.length ? r.sinks[0].urls : [];
        for (const url of sinkUrls) {
          const sinkHost = safeUrlToHostname(url);
          const sinkETLD1 = naiveETLD1(sinkHost);
          const thirdParty = isThirdPartySink(dump.pageHost, sinkHost);

          const candidateSources = [].concat(r.sources || []).concat(r.inheritedSources || []);
          const echoMatches = [];

          for (const src of candidateSources) {
            if (!src || !src.requiresEcho) continue;
            if (!src.echoTokens || !src.echoTokens.length) continue;
            if (!urlEchoesTokens(url, src.echoTokens)) continue;

            echoMatches.push({
              ruleIndex: i,
              reason: r.sources && r.sources.includes(src) ? "same-rule" : "ancestor-group",
              category: src.category,
              keyword: src.keyword,
              claim: src.claim,
              semanticGroup: src.semanticGroup,
              excerpt: src.excerpt,
              evidence: { echoConfirmed: true }
            });

            const key = `${src.semanticGroup}|${src.claim}|${src.keyword}`;
            if (!claimDetailsMap.has(key)) {
              claimDetailsMap.set(key, {
                category: src.category,
                semanticGroup: src.semanticGroup,
                keyword: src.keyword,
                claim: src.claim,
                risk: riskFor(src.semanticGroup),
                explanation: explanationFor(src.semanticGroup, src.keyword, src.claim)
              });
            }
          }

          if (echoMatches.length) {
            dump.associations.push({
              associationTier: "echo", // Tier 1
              sheet: sheetRec.href,
              sinkRuleIndex: i,
              sinkUrl: url,
              sinkHost,
              sinkETLD1,
              isThirdParty: thirdParty,
              identifierLike: looksLikeIdentifierUrl(url),
              matchedSources: echoMatches
            });
            tier1Count++;
            continue;
          }

          // Tier 2 dependency-confirmed: only if we have eligible high-trust sources
          const eligible = candidateSources.filter((src) => eligibleForTier2(src));
          if (!eligible.length) continue;

          const depMatches = eligible.map((src) => {
            const key = `${src.semanticGroup}|${src.claim}|${src.keyword}`;
            if (!claimDetailsMap.has(key)) {
              claimDetailsMap.set(key, {
                category: src.category,
                semanticGroup: src.semanticGroup,
                keyword: src.keyword,
                claim: src.claim,
                risk: riskFor(src.semanticGroup),
                explanation: explanationFor(src.semanticGroup, src.keyword, src.claim)
              });
            }
            return {
              ruleIndex: i,
              reason: r.sources && r.sources.includes(src) ? "same-rule" : "ancestor-group",
              category: src.category,
              keyword: src.keyword,
              claim: src.claim,
              semanticGroup: src.semanticGroup,
              excerpt: src.excerpt,
              evidence: {
                echoConfirmed: false,
                dependencyConfirmed: true
              }
            };
          });

          dump.associations.push({
            associationTier: "dependency", // Tier 2
            sheet: sheetRec.href,
            sinkRuleIndex: i,
            sinkUrl: url,
            sinkHost,
            sinkETLD1,
            isThirdParty: thirdParty,
            identifierLike: looksLikeIdentifierUrl(url),
            matchedSources: depMatches
          });
          tier2Count++;
        }
      }
    }

    // ---------------- claims / risk details ----------------
    const claims = [];
    for (const a of dump.associations) {
      if (!a.matchedSources) continue;
      for (const s of a.matchedSources) claims.push(`${s.semanticGroup}: ${s.claim}`);
    }
    const uniqueClaims = Array.from(new Set(claims)).sort();

    // ---------------- summary metrics ----------------
    const hasTier1 = dump.associations.some((a) => a.associationTier === "echo");
    const hasTier2 = dump.associations.some((a) => a.associationTier === "dependency");

    const depOnlyAssocs = dump.associations.filter((a) => a.associationTier === "dependency");
    const depMetrics = computeDependencyLikelihoodMetrics(dump, depOnlyAssocs);
    const depScore = scoreDependencyLikelihood(depMetrics);

    // FIX: do not claim "dependency-confirmed" activity if there are zero dependency associations
    const depLabel = depOnlyAssocs.length > 0 ? labelFromScore(depScore) : "none";

    dump.summary = {
      sheetsAccessible: dump.sheets.filter((s) => s.rules !== "inaccessible").length,
      sheetsInaccessible: dump.inaccessible.length,
      totalRulesScanned: dump.sheets.reduce((acc, s) => acc + (Array.isArray(s.rulesList) ? s.rulesList.length : 0), 0),
      totalSinks: dump.sheets.reduce(
        (acc, s) =>
          acc +
          (Array.isArray(s.rulesList)
            ? s.rulesList.reduce((a, r) => a + (r.sinks ? r.sinks.length : 0), 0)
            : 0),
        0
      ),
      totalSources: dump.sheets.reduce(
        (acc, s) =>
          acc +
          (Array.isArray(s.rulesList)
            ? s.rulesList.reduce((a, r) => a + (r.sources ? r.sources.length : 0), 0)
            : 0),
        0
      ),
      totalAssociations: dump.associations.length,
      tier1EchoAssociations: tier1Count,
      tier2DependencyAssociations: tier2Count,
      totalCapped: totalCountBox.count >= MAX_TOTAL_RULES,

      dependencyMetrics: depMetrics,
      dependencyScore: depScore,
      dependencyLabel: depLabel
    };

    dump.claims = uniqueClaims;

    dump.claimDetails = Array.from(claimDetailsMap.values()).sort(
      (a, b) => b.risk - a.risk || (a.claim || "").localeCompare(b.claim || "")
    );

    // Note: riskScore here is "privacy risk from claims observed", not "fingerprinting likelihood"
    const totalRisk = dump.claimDetails.reduce((acc, c) => acc + (c.risk || 0), 0);
    dump.riskScore = totalRisk;
    dump.riskLevel = totalRisk >= 7 ? "high" : totalRisk >= 3 ? "medium" : totalRisk > 0 ? "low" : "none";

    // ---------------- final verdict / likelihood ----------------
    if (hasTier1) {
      dump.fingerprintingLikelihood = "likely";
      dump.verdict = "likely fingerprinting (echo-confirmed)";
    } else if (hasTier2) {
      // hasTier2 implies depOnlyAssocs.length > 0, so depLabel will not be "none"
      dump.verdict = depLabel;
      dump.fingerprintingLikelihood =
        depLabel.indexOf("likely fingerprinting") >= 0
          ? "likely"
          : depLabel.indexOf("potential fingerprinting") >= 0
          ? "potential"
          : "low";
    } else {
      dump.fingerprintingLikelihood = "none";
      dump.verdict = "likely not fingerprinting";
    }

    // Backwards-compat booleans
    dump.likelyFingerprintingEcho = !!hasTier1;
    dump.likelyFingerprintingDependency = !!hasTier2;
    dump.likelyFingerprinting = !!hasTier1; // keep strict for "likely": only echo
    dump.potentialFingerprinting = !hasTier1 && hasTier2 && depScore >= 5;

    // save + send to extension
    window.__lastCssDump = dump;
    try {
      chrome.runtime.sendMessage({ type: "cssDump", payload: dump }, function () {});
    } catch (e) {
      console.warn("chrome.runtime.sendMessage failed:", e);
      console.log("dump:", dump);
    }
  })();
}
