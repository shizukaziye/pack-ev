// Combine the per-game files the scraper writes into the single data/cards.json
// the page reads. Kept separate so one game can be re-scraped on its own without
// disturbing the other two.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LINES } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = { updated: new Date().toISOString(), games: {} };
let oldest = null;
const missing = [];

for (const game of Object.keys(LINES)) {
  try {
    const f = JSON.parse(await readFile(join(ROOT, "data", `cards.${game}.json`), "utf8"));
    // A set with no release date cannot be matched to an era, and the only one that
    // shows up that way is Pokemon's "Miscellaneous Cards & Products" grab bag, which
    // is not a set anybody opens packs of.
    // Also drop sets with nothing to price — a few promo-pack products (First Partner
    // Collection) have almost no catalogued singles, so their EV would just read $0.
    // And drop the novelty packs: Trick or Trade is a Halloween mini-pack and the
    // McDonald's sets are giveaways. Both are sold as "booster packs" but have no
    // rarity structure for an era template to price, so they come out at $0.
    const NOT_BOOSTERS = /trick or trade|mcdonald/i;
    const dated = f.sets.filter((s) => s.release && s.buckets.length && !NOT_BOOSTERS.test(s.set));
    const dropped = f.sets.length - dated.length;
    out.games[game] = dated;
    if (!oldest || f.updated < oldest) oldest = f.updated;
    console.log(
      `${game}: ${dated.length} sets (scraped ${f.updated.slice(0, 16).replace("T", " ")})` +
      (dropped
        ? ` — dropped ${dropped}: ${f.sets.filter((s) => !dated.includes(s)).map((s) => s.set).join(", ")}`
        : "")
    );
  } catch {
    missing.push(game);
    out.games[game] = [];
    console.log(`${game}: MISSING — data/cards.${game}.json not found`);
  }
}

// The page shows one timestamp, so it should be the oldest part of what it shows,
// not the moment the files were stitched together.
if (oldest) out.updated = oldest;

await writeFile(join(ROOT, "data", "cards.json"), JSON.stringify(out, null, 1));
const total = Object.values(out.games).reduce((a, b) => a + b.length, 0);
console.log(`\nWrote data/cards.json — ${total} sets.`);
if (missing.length) {
  console.error(`Missing games: ${missing.join(", ")}`);
  process.exit(1);
}
