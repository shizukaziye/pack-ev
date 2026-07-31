// Runs the EV model over the scraped data and reports anything that looks wrong.
// This is the check that the model is wired to the data correctly — a rate that
// matches no bucket silently drops value, and that is the failure mode that would
// quietly make every number too low.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { packEV, templateFor, confidenceOf } from "../ev.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const money = (n) => (n == null ? "  —   " : ("$" + n.toFixed(2)).padStart(8));
const pct = (n) => (n == null ? "  — " : (n * 100).toFixed(0).padStart(3) + "%");

const cards = JSON.parse(await readFile(join(ROOT, "data", "cards.json"), "utf8"));
const rates = JSON.parse(await readFile(join(ROOT, "data", "rates.json"), "utf8"));

const problems = [];
let count = 0;

for (const [game, sets] of Object.entries(cards.games)) {
  console.log(`\n${"=".repeat(104)}\n${game.toUpperCase()}  (${sets.length} sets)\n${"=".repeat(104)}`);
  console.log(
    "release    set".padEnd(46) + "pack EV".padStart(9) + "pack".padStart(9) + " ret" +
    "   box EV".padStart(10) + "box".padStart(10) + "  ret  conf"
  );
  for (const set of sets) {
    const tpl = templateFor(rates, game, set.release, set.set);
    if (!tpl) { problems.push(`${game}/${set.set}: no template`); continue; }
    const r = packEV(set, tpl);
    const conf = confidenceOf(set, tpl, r);
    count++;

    console.log(
      `${(set.release || "????-??-??")}  ${set.set.slice(0, 42).padEnd(42)}` +
      money(r.ev) + money(r.packPrice) + " " + pct(r.packReturn) +
      money(r.boxEV) + money(r.boxPrice) + " " + pct(r.boxReturn) + "  " + conf.level
    );

    // --- the checks ---
    // Slots with no market value (tokens, runes) are counted by the template but
    // never priced, so allow for them before calling the card count wrong.
    const expected = tpl.cardsPerPack - (tpl.unpricedPerPack || 0);
    if (Math.abs(r.cardsPerPack - expected) > 0.6)
      problems.push(`${game}/${set.set}: rates sum to ${r.cardsPerPack.toFixed(2)} priced cards, expected ~${expected}`);
    for (const l of r.lines)
      if (l.empty && l.perPack >= 0.05)
        problems.push(`${game}/${set.set}: rate "${l.label}" (${l.perPack}/pack) matched no cards`);
    if (r.ev === 0) problems.push(`${game}/${set.set}: EV is zero`);
    if (r.packReturn != null && r.packReturn > 3)
      problems.push(`${game}/${set.set}: pack return ${(r.packReturn * 100).toFixed(0)}% — implausibly high, check rates`);
  }
}

// Rarity names present in the data that no rate mentions: value falling on the floor.
console.log(`\n${"=".repeat(104)}\nUNMATCHED RARITIES (cards the model never prices)\n${"=".repeat(104)}`);
for (const [game, sets] of Object.entries(cards.games)) {
  const seen = new Map();
  for (const set of sets) {
    const tpl = templateFor(rates, game, set.release, set.set);
    if (!tpl) continue;
    for (const b of set.buckets) {
      const matched = tpl.rates.some((rt) => {
        const m = rt.match;
        if (m.rarity && !m.rarity.includes(b.rarity)) return false;
        if (m.printing && !m.printing.includes(b.printing)) return false;
        if (m.variant && !m.variant.includes(b.variant)) return false;
        return true;
      });
      if (!matched) {
        const k = `${b.rarity} | ${b.printing} | ${b.variant}`;
        const cur = seen.get(k) || { n: 0, sets: 0, val: 0 };
        cur.n += b.n; cur.sets++; cur.val = Math.max(cur.val, b.max || 0);
        seen.set(k, cur);
      }
    }
  }
  const rows = [...seen.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`\n${game}:`);
  if (!rows.length) console.log("  (everything is priced by some rate)");
  for (const [k, v] of rows.slice(0, 18))
    console.log(`  ${k.padEnd(52)} ${String(v.n).padStart(5)} cards in ${String(v.sets).padStart(3)} sets, top $${v.val}`);
}

console.log(`\n${"=".repeat(104)}\n${count} sets priced. ${problems.length} problems.`);
for (const p of problems.slice(0, 60)) console.log("  - " + p);
if (problems.length > 60) console.log(`  ... and ${problems.length - 60} more`);
