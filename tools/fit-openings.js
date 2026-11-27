#!/usr/bin/env node
/* Post-process plan-data.js after extraction: openings detected up to a neighbouring wall's
 * face can poke a few inches into a mitred corner. Trim them to the wall's clear length
 * (computed with the same join logic the 3D view uses) and record the change.
 * Usage: node tools/fit-openings.js plan-data.js   (rewrites the file in place) */
const fs = require('fs'), path = require('path');
const file = path.resolve(process.argv[2] || 'plan-data.js');
const Core = require(path.join(__dirname, '..', 'plan-core.js'));
delete require.cache[file];
const plan = require(file);
const joins = Core.analyzeJoins(plan.walls);
let changed = 0;
for (const o of plan.openings) {
  const i = plan.walls.findIndex(w => w.id === o.wall);
  const [c0, c1] = joins[i].clear;
  let s0 = o.offset - o.width / 2, s1 = o.offset + o.width / 2;
  if (s0 >= c0 - 1e-3 && s1 <= c1 + 1e-3) continue;
  const before = o.width;
  s0 = Math.max(s0, c0); s1 = Math.min(s1, c1);
  if (s1 - s0 < 0.5 || before - (s1 - s0) > 1.0) { console.error(`! ${o.id}: needs a manual fix`); continue; }
  o.offset = +((s0 + s1) / 2).toFixed(4); o.width = +(s1 - s0).toFixed(4); changed++;
  plan.assumptions.push(`Opening ${o.id} on ${o.wall} trimmed from ${Core.formatFtIn(before)} to ${Core.formatFtIn(o.width)} so it stops at the neighbouring wall's face.`);
}
const src = fs.readFileSync(file, 'utf8');
const start = src.indexOf('const PLAN = ') + 'const PLAN = '.length, end = src.indexOf(';\nif (typeof module');
let js = JSON.stringify(plan, null, 1).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]');
fs.writeFileSync(file, src.slice(0, start) + js + src.slice(end));
console.error(`fit-openings: ${changed} opening(s) trimmed`);
