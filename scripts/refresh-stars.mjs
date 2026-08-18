#!/usr/bin/env node
/**
 * Refreshes star counts in index.html + README.md against the live GitHub
 * API, in place — does NOT touch anything else (thumbnails, copy, layout).
 *
 * Runs hourly via .github/workflows/refresh-stars.yml, using the default
 * GITHUB_TOKEN (no cross-repo secret needed — this only ever writes to
 * this repo). Safe to also run locally: `node scripts/refresh-stars.mjs`.
 *
 * Deliberately skips any entry whose current stars value isn't a plain
 * number/k-notation (e.g. ai-jury's "Gem 💎", weekend-toolkit's "") —
 * those are intentional, hand-authored special cases, not stale counts.
 *
 * This is display-only. The authored source of truth for a repo's card
 * (channels/weekendrepos/content/<slug>.yml in instatech) is a fact-checked
 * snapshot at publish time and is never touched by this script — a
 * published video's on-screen star count stays frozen forever, per
 * instatech's CLAUDE.md invariant that a published video is immutable.
 * Only this companion site's live display updates.
 */
import { readFileSync, writeFileSync } from "node:fs";

const NUMERIC_STARS = /^\d+(\.\d+)?k?$/i;

function formatStars(n) {
  if (n < 1000) return String(n);
  const k = Math.round((n / 1000) * 10) / 10;
  return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + "k";
}

async function fetchStars(fullName) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  if (!res.ok) throw new Error(`${fullName}: ${res.status}`);
  const data = await res.json();
  return data.stargazers_count;
}

async function main() {
  const htmlPath = new URL("../index.html", import.meta.url);
  let html = readFileSync(htmlPath, "utf8");

  const match = html.match(/const REPOS = (\[.*?\]);/s);
  if (!match) throw new Error("Could not find the REPOS array in index.html");
  const repos = JSON.parse(match[1]);

  const updates = []; // { slug, fullName, from, to }
  for (const r of repos) {
    if (!NUMERIC_STARS.test(r.stars ?? "")) continue; // hand-authored special case — leave alone
    try {
      const live = await fetchStars(r.fullName);
      const formatted = formatStars(live);
      if (formatted !== r.stars) {
        updates.push({ slug: r.slug, fullName: r.fullName, from: r.stars, to: formatted });
        r.stars = formatted;
      }
    } catch (err) {
      console.warn(`skip ${r.fullName}: ${err.message}`);
    }
  }

  if (updates.length === 0) {
    console.log("No star counts changed.");
    return;
  }

  // Splice the updated array back into the REPOS const, byte-for-byte
  // elsewhere — no other part of the file is touched.
  html = html.slice(0, match.index) + `const REPOS = ${JSON.stringify(repos)};` + html.slice(match.index + match[0].length);

  // Visible per-card badge: cards render in the same order as REPOS, one
  // <span class="card-stars">★ X</span> per card — walk them in lockstep.
  let cardIndex = 0;
  html = html.replace(/(<span class="card-stars">★ )([^<]*)(<\/span>)/g, (whole, pre, old, post) => {
    const r = repos[cardIndex++];
    return `${pre}${esc(r.stars)}${post}`;
  });

  writeFileSync(htmlPath, html, "utf8");

  // repos/<slug>/index.html — the detail pages carry the same badge as the
  // card ("★ X" inside .facts). Without this they would keep the
  // authoring-time snapshot forever, and the same repo would show two
  // different star counts on two pages of the same site.
  for (const u of updates) {
    const pagePath = new URL(`../repos/${u.slug}/index.html`, import.meta.url);
    let page;
    try {
      page = readFileSync(pagePath, "utf8");
    } catch {
      continue; // no detail page for this slug — nothing to refresh
    }
    const badgeRe = new RegExp(`(<span>★ )${escapeRegExp(u.from)}(</span>)`);
    if (!badgeRe.test(page)) continue;
    writeFileSync(pagePath, page.replace(badgeRe, `$1${esc(u.to)}$2`), "utf8");
  }

  // README.md table — one row per repo, "| [fullName](url) | stars | ..." —
  // match by fullName so row order doesn't matter.
  const readmePath = new URL("../README.md", import.meta.url);
  let readme = readFileSync(readmePath, "utf8");
  for (const u of updates) {
    const rowRe = new RegExp(`(\\[${escapeRegExp(u.fullName)}\\]\\([^)]*\\) \\| )${escapeRegExp(u.from)}( \\|)`);
    readme = readme.replace(rowRe, `$1${u.to}$2`);
  }
  writeFileSync(readmePath, readme, "utf8");

  console.log(`Updated ${updates.length} star count(s):`);
  for (const u of updates) console.log(`  ${u.fullName}: ${u.from} -> ${u.to}`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Same escaping awesome-list.ts uses, kept local so this script has no
// dependency on the instatech repo.
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
