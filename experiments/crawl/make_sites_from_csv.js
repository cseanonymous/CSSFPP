// Usage: node make_sites_from_csv.js website-list.csv > sites.txt
const fs = require('fs');

const csv = fs.readFileSync(process.argv[2], 'utf8')
  .split(/\r?\n/).map(l => l.trim()).filter(Boolean);

// Try to detect header
const hadHeader = /rank|domain|site/i.test(csv[0]);
const lines = hadHeader ? csv.slice(1) : csv;

function pickDomain(line){
  const parts = line.split(',');
  // pick cell that looks like a domain
  const dom = parts.find(c => /\.[a-z]{2,}$/.test(c.replace(/"/g,''))) || parts[0];
  return dom.replace(/"/g,'').trim();
}

const uniq = new Set();
for (const l of lines) {
  const d = pickDomain(l)
    .replace(/^https?:\/\//i,'')
    .replace(/^www\./i,'')
    .replace(/\/.*$/,'')
    .toLowerCase();
  if (d) uniq.add(d);
}

console.log([...uniq].join('\n'));
