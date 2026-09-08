#!/usr/bin/env node
// Bumps the ?v= cache-busting query string for one or more asset paths
// across every .html file in the project.
//
// Why this exists: vercel.json serves everything under /js/ and /css/
// with `Cache-Control: public, max-age=31536000, immutable`. That means
// once a browser (or Vercel's edge cache) has fetched e.g. css/style.css
// under a given ?v= value, it will NEVER re-check that URL for up to a
// year — deploying new file contents under the same URL does nothing for
// anyone who already has it cached. The only way to force a fresh fetch
// is to change the URL itself, i.e. bump the version string.
//
// Usage:
//   node scripts/bump-version.mjs css/style.css js/profile.js
//   node scripts/bump-version.mjs --all        (bump every versioned js/css asset)
//
// Matching is done on the exact path (e.g. "js/profile.js"), anchored so
// it can never accidentally match "js/editprofile.js" or similar.

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const bumpAll = args.includes('--all');
const targets = args.filter(a => a !== '--all');

const htmlFiles = readdirSync(root).filter(f => f.endsWith('.html'));

// Matches: (js|css)/<name> optionally followed by ?v=<version>
// Captures: 1=full path e.g. "js/profile.js", 2=existing version or undefined
const ASSET_RE = /((?:js|css)\/[a-zA-Z0-9_-]+\.(?:js|css))(\?v=([0-9a-zA-Z]+))?/g;

function nextVersion(old) {
  // If it ends in a letter, bump the letter (a->b, ..., z->aa).
  // If it's purely numeric (a date, e.g. 20260820), append 'a'.
  const m = old && old.match(/^(.*?)([a-z]*)$/);
  if (!m) return (old || '') + 'a';
  const [, base, letters] = m;
  if (!letters) return old + 'a';
  const bumped = bumpLetters(letters);
  return base + bumped;
}
function bumpLetters(letters) {
  const arr = letters.split('');
  let i = arr.length - 1;
  while (i >= 0) {
    if (arr[i] === 'z') { arr[i] = 'a'; i--; }
    else { arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1); return arr.join(''); }
  }
  return 'a' + arr.join('');
}

// First pass: find the CURRENT version for each targeted path, so every
// HTML file that references it gets bumped to the same new version
// (some assets are referenced with different stray versions per page —
// we still converge them all to one new value).
const currentVersions = new Map();
for (const file of htmlFiles) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const match of text.matchAll(ASSET_RE)) {
    const [, path, , version] = match;
    if (bumpAll || targets.includes(path)) {
      if (!currentVersions.has(path) || (version && version > currentVersions.get(path))) {
        currentVersions.set(path, version || '');
      }
    }
  }
}

if (targets.length && !bumpAll) {
  for (const t of targets) {
    if (!currentVersions.has(t)) {
      console.error(`Warning: "${t}" was not found referenced (with or without ?v=) in any .html file — skipping.`);
    }
  }
}

const newVersions = new Map();
for (const [path, oldV] of currentVersions) {
  newVersions.set(path, nextVersion(oldV));
}

let filesChanged = 0;
for (const file of htmlFiles) {
  const full = join(root, file);
  let text = readFileSync(full, 'utf8');
  let changed = false;
  text = text.replace(ASSET_RE, (whole, path, qs, version) => {
    if (!newVersions.has(path)) return whole;
    changed = true;
    return `${path}?v=${newVersions.get(path)}`;
  });
  if (changed) {
    writeFileSync(full, text);
    filesChanged++;
  }
}

console.log(`Bumped ${newVersions.size} asset(s) across ${filesChanged} HTML file(s):`);
for (const [path, v] of newVersions) {
  console.log(`  ${path} -> ?v=${v}`);
}
