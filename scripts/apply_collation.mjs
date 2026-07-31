// Turn the One Piece case-collation figures into per-set rates.
//
// Until now every One Piece set shared one template, because nothing per-set existed.
// tcgtrading.cards derives its rates from how a sealed case is collated — 12 boxes,
// each with a known set of guaranteed hits — which is a structural constraint rather
// than a survey, and it differs set to set. That is a real improvement on one shared
// guess, though still not counted packs, so these stay badged "estimated".
//
// The source only models the chase tiers. Commons, uncommons, rares and the plain
// Leader keep the template's figures, which is exactly what the setRates merge does.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Their card-type names on the left, this model's rate labels on the right.
const LABELS = {
  "Super Rare": "Super Rare",
  "Secret Rare": "Secret Rare",
  "Alt Art": "Alternate art (not Leader)",
  "Alt-Art Leader": "Alt-art Leader",
  "Special Art": "Special art (SP)",
  "Manga Rare": "Manga rare",
  "Gold DON!!": "Gold DON!!",
  // OP05's anniversary cards are filed by TCGplayer under the same special-art
  // treatment, so they fold into that line rather than getting one of their own.
  Anniversary: "Special art (SP)",
};

const collation = JSON.parse(await readFile(join(ROOT, "data", "onepiece_collation.json"), "utf8"));
const rates = JSON.parse(await readFile(join(ROOT, "data", "rates.json"), "utf8"));
const cards = JSON.parse(await readFile(join(ROOT, "data", "cards.json"), "utf8"));

// setCode in the price data is "OP16"/"EB-03"/"OP15-EB04"; normalise to compare.
const norm = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const bySet = new Map();
for (const s of cards.games.onepiece) bySet.set(norm(s.setCode), s);

const PER_PACK = collation.packsPerCase;
let wrote = 0;
const missed = [];

for (const [code, perCase] of Object.entries(collation.sets)) {
  // "OP15-EB04" is one set printed as both, so match on either half.
  const set =
    bySet.get(norm(code)) ||
    cards.games.onepiece.find((s) => norm(s.setCode).includes(norm(code)));
  if (!set) { missed.push(code); continue; }

  const out = {};
  for (const [kind, n] of Object.entries(perCase)) {
    const label = LABELS[kind];
    if (!label) { missed.push(`${code}:${kind}`); continue; }
    out[label] = Number((n / PER_PACK).toFixed(6));
  }

  rates.setRates[set.set] = {
    manual: true,
    confidence: "estimated",
    sample: "derived from how a sealed case is collated — 12 boxes, each with known guaranteed hits — rather than from counted packs",
    source: collation.source.replace("{code}", code.toLowerCase()),
    note: `Chase rates for ${code} read off the case collation: a case is 12 boxes of 24 packs, and the guaranteed hits per box fix how many of each turn up. Bandai publishes no odds, so this is the nearest thing to a structural figure. The common, uncommon and rare lines are still era estimates.`,
    rates: out,
  };
  wrote++;
  console.log(`  ✓ ${code.padEnd(6)} ${set.set.slice(0, 40).padEnd(42)} ${Object.entries(out).map(([k, v]) => `${k.split(" ")[0]}=${v}`).join(" ")}`);
}

await writeFile(join(ROOT, "data", "rates.json"), JSON.stringify(rates, null, 2));
console.log(`\nWrote per-set rates for ${wrote} One Piece sets.`);
if (missed.length) console.log(`Unmatched: ${missed.join(", ")}`);
