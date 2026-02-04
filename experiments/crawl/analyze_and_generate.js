// Usage: node analyze_and_generate.js
import fs from 'fs';
import path from 'path';
import postcss from 'postcss';
import safeParser from 'postcss-safe-parser';
import nesting from 'postcss-nesting';
import selectorParser from 'postcss-selector-parser';

const CSS_DIR = 'out/css';
const TOP_N = 25;

// ---------- helpers ----------
function inc(map, key, by = 1) { map[key] = (map[key] || 0) + by; }
function top(map, n = TOP_N) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
}
function listFiles(dir) {
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.css')).map(f => path.join(dir, f));
}

// ---------- tallies ----------
const tally = {
  files: 0,
  atRules: {},
  mediaParams: {},
  supportsParams: {},
  containerKind: { size: 0, style: 0 },
  selectors: { pseudos: {}, attributes: 0, combinators: 0, nestedAmpersand: 0 },
  properties: {},
  urlSinks: { background: 0, listStyle: 0, mask: 0, cursor: 0, borderImage: 0, clipPath: 0, filter: 0, src: 0 },
  fonts: { fontFace: 0, unicodeRange: 0, varSettings: 0, localSrc: 0 },
  animations: { keyframes: 0, animationDecl: 0, transitionDecl: 0 }
};

// ---------- selector scan ----------
function scanSelector(sel) {
  if (sel.includes('&')) { tally.selectors.nestedAmpersand++; return; }
  let attr = false, comb = false;
  try {
    selectorParser(selectors => {
      selectors.walkPseudos(p => inc(tally.selectors.pseudos, p.value));
      selectors.walkAttributes(() => { attr = true; });
      selectors.walkCombinators(c => { if (['>','+','~','||'].includes(c.value)) comb = true; });
    }).processSync(sel);
  } catch { return; }
  if (attr) tally.selectors.attributes++;
  if (comb) tally.selectors.combinators++;
}

// ---------- declaration scan ----------
function scanDecl(prop, value = '') {
  const p = prop.toLowerCase();
  inc(tally.properties, p);

  if (/url\(/i.test(value)) {
    if (/^background/i.test(p)) tally.urlSinks.background++;
    else if (/^list-style/i.test(p)) tally.urlSinks.listStyle++;
    else if (/^(mask|mask-image)/i.test(p)) tally.urlSinks.mask++;
    else if (/^cursor$/i.test(p)) tally.urlSinks.cursor++;
    else if (/^border-image/i.test(p)) tally.urlSinks.borderImage++;
    else if (/^clip-path$/i.test(p)) tally.urlSinks.clipPath++;
    else if (/^filter$/i.test(p)) tally.urlSinks.filter++;
    else if (/^src$/i.test(p)) tally.urlSinks.src++;
  }

  if (/animation/i.test(p)) tally.animations.animationDecl++;
  if (/transition/i.test(p)) tally.animations.transitionDecl++;
  if (p === 'font-variation-settings') tally.fonts.varSettings++;
  if (p === 'unicode-range') tally.fonts.unicodeRange++;
  if (p === 'src' && /local\(/i.test(value)) tally.fonts.localSrc++;
}

// ---------- safe parser w/ nesting ----------
function parseSafe(css) {
  const transformed = postcss([nesting]).process(css, { from: undefined, parser: safeParser }).css;
  return postcss().process(transformed, { parser: safeParser, from: undefined }).root;
}

async function scanFile(file) {
  const css = fs.readFileSync(file, 'utf8');
  let root;
  try { root = parseSafe(css); }
  catch (e) { console.warn('skip (unparseable CSS):', path.basename(file)); return; }

  tally.files++;

  root.walkAtRules(ar => {
    const name = '@' + ar.name.toLowerCase();
    inc(tally.atRules, name);
    if (name === '@media') inc(tally.mediaParams, ar.params);
    if (name === '@supports') inc(tally.supportsParams, ar.params);
    if (name === '@font-face') tally.fonts.fontFace++;
    if (name === '@keyframes') tally.animations.keyframes++;
    if (name === '@container') (/style\(/i.test(ar.params) ? tally.containerKind.style++ : tally.containerKind.size++);
  });

  root.walkRules(r => { if (r.selector) scanSelector(r.selector); });
  root.walkDecls(d => scanDecl(d.prop, d.value));
}

// ---------- CSS generation helpers (NEW) ----------
const SCOPE = ':where(.probe-scope)';          // prevents page-wide effects
const LAYER_OPEN = '@layer probes {\n';
const LAYER_CLOSE = '\n} /* end @layer probes */\n';

const sc = (sel) => `${SCOPE} ${sel}`;
const block = (sel, body) => `${sc(sel)}{\n${body}\n}\n\n`;

function sampleDecls(props) {
  const lines = [];
  const cap = Math.min(props.length, 10);
  for (let i = 0; i < cap; i++) {
    const p = props[i];
    const val =
      p.includes('color') ? '#369' :
      /background/.test(p) ? '#eee' :
      /width|size|gap|radius|indent|margin|padding|height|inset|top|left|right|bottom/.test(p) ? '12px' :
      /font/.test(p) ? (p === 'font-family' ? 'ProbeFont,system-ui,sans-serif' : '14px') :
      /display/.test(p) ? 'block' :
      /position/.test(p) ? 'relative' :
      /opacity/.test(p) ? '0.9' :
      /z-index/.test(p) ? '1' :
      /border/.test(p) ? '1px dashed #aaa' :
      /flex|grid/.test(p) ? '1' : 'initial';
    lines.push(`  ${p}: ${val};`);
  }
  return lines.join('\n');
}

// ---------- drive ----------
(async () => {
  if (!fs.existsSync(CSS_DIR)) {
    console.error(`No CSS directory found at ${CSS_DIR}`);
    process.exit(1);
  }

  const files = listFiles(CSS_DIR);
  for (const f of files) await scanFile(f);

  // --- console report ---
  console.log('\n=== CSS Feature Summary ===');
  console.log('Files scanned:', tally.files);
  console.log('\nTop at-rules:');         for (const [k,v] of top(tally.atRules)) console.log(`${k.padEnd(14)} ${v}`);
  console.log('\nTop properties:');       for (const [k,v] of top(tally.properties)) console.log(`${k.padEnd(24)} ${v}`);
  console.log('\nTop media queries:');    for (const [k,v] of top(tally.mediaParams, 15)) console.log(`${String(v).padStart(6)}  ${k}`);
  console.log('\nTop supports() tests:'); for (const [k,v] of top(tally.supportsParams, 15)) console.log(`${String(v).padStart(6)}  ${k}`);
  console.log('\nSelector pseudos:');     for (const [k,v] of top(tally.selectors.pseudos)) console.log(`${k.padEnd(14)} ${v}`);
  console.log(`attributes: ${tally.selectors.attributes}, combinators: ${tally.selectors.combinators}, nestedAmpersand: ${tally.selectors.nestedAmpersand}`);
  console.log('\nURL sinks by property:'); Object.entries(tally.urlSinks).forEach(([k,v]) => console.log(`${k.padEnd(12)} ${v}`));
  console.log('\nFonts:', tally.fonts);
  console.log('Animations:', tally.animations);
  console.log('Container (size/style):', tally.containerKind);

  fs.writeFileSync('css_feature_summary.json', JSON.stringify(tally, null, 2));
  console.log('\nWrote css_feature_summary.json');

  // --- generate scoped, layered probe.css ---
  const topProps      = top(tally.properties, 20).map(([p]) => p);
  const chosenMedia   = top(tally.mediaParams, 3).map(([m]) => m);
  const chosenSupports= top(tally.supportsParams, 3).map(([s]) => s);
  const pseudoList    = top(tally.selectors.pseudos, 8).map(([p]) => p);
  const sinkTargets   = Object.entries(tally.urlSinks).filter(([,v]) => v > 0).map(([k]) => k);

  let probe = `/* Auto-generated representative CSS probe
   - Safe by default: scoped to ${SCOPE} and wrapped in @layer probes
   - Place small placeholders next to your HTML: probe.png / probe.svg / probe.woff2
*/\n\n${LAYER_OPEN}`;

  // a tiny reset within the scope to stabilize visuals
  probe += `${sc('*')}{box-sizing:border-box}\n${sc('ul')}{margin:0;padding:0}\n\n`;

  if (tally.fonts.fontFace > 0) {
    probe += `@font-face{font-family:"ProbeFont";src:local("Inter"),url("probe.woff2") format("woff2");font-weight:400;font-style:normal}\n\n`;
  }
  if (tally.atRules['@container']) {
    const useStyle = tally.containerKind.style > 0;
    probe += block('.cq-box', `${useStyle ? 'container-type:style;' : 'container-type:inline-size;'} border:1px solid #e0e0e0; padding:8px; width:360px;`);
    probe += `@container ${useStyle ? 'style(font-weight:700)' : '(min-width:240px)'} { ${sc('.cq-probe')}{ outline:2px dashed #0aa; } }\n\n`;
  }

  // media / supports
  chosenMedia.forEach((m,i)=>{ probe += `@media ${m}{ ${sc('.m'+i)}{ outline:2px dashed #777; } }\n`; });
  if (chosenMedia.length) probe += '\n';
  chosenSupports.forEach((s,i)=>{ probe += `@supports ${s}{ ${sc('.s'+i)}{ outline:2px dotted #999; } }\n`; });
  if (chosenSupports.length) probe += '\n';

  // guaranteed animation and transition
  probe += `@keyframes probeSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}\n`;
  probe += block('.probe-anim-loop', `animation:probeSpin 1.2s linear infinite; background:#e8f2ff; border:1px solid #9bbdf2;`);
  probe += block('.probe-trans', `transition:transform .35s ease, opacity .35s ease;`);
  probe += block('.probe-trans.go', `transform:translateX(20px); opacity:.7;`);

  // representative selectors
  const selBlocks = [
    '.rep .child', '.rep:hover', '.rep:focus-visible',
    '[data-prop="x"]', ':where(.rep-a,.rep-b)', ':is(section,article) .rep'
  ];
  if (pseudoList.includes(':has')) selBlocks.push('.rep:has(img)');
  selBlocks.forEach(sel => { probe += block(sel, sampleDecls(topProps)); });

  // URL sinks (with gentle visuals)
  const sinkRuleFor = (bucket) => ({
    background:  `${sc('.sink-bg')}{ background:url('probe.png') no-repeat center/contain; }`,
    listStyle:   `${sc('.sink-list')}{ list-style-image:url('probe.png'); }`,
    mask:        `${sc('.sink-mask')}{ -webkit-mask-image:url('probe.png'); mask-image:url('probe.png'); }`,
    cursor:      `${sc('.sink-cursor')}{ cursor:url('probe.png'), pointer; }`,
    borderImage: `${sc('.sink-border')}{ border:10px solid transparent; border-image:url('probe.png') 10 stretch; }`,
    clipPath:    `${sc('.sink-clip')}{ clip-path:url('probe.svg#f1'); }`,
    filter:      `${sc('.sink-filter')}{ filter:url('probe.svg#f1'); }`,
    src:         `@font-face{ font-family:'SinkFont'; src:url('probe.woff2') format('woff2'); }`
  }[bucket] || '');
  sinkTargets.forEach(b => { const r = sinkRuleFor(b); if (r) probe += r + '\n'; });

  probe += LAYER_CLOSE;

  fs.writeFileSync('probe.css', probe);
  console.log('Wrote probe.css (scoped + layered).');
})();
