// Price every card in every set that still sells packs, and roll them up into
// the buckets the EV model prices.
//
// Pokemon goes through TCGplayer's Infinite price guide: one request returns the
// whole set with every printing named (Normal / Reverse Holofoil / Holofoil).
// Infinite has no data for One Piece or Riftbound, so those page the whole product
// line once and group by set. One Piece needs nothing more — each rarity there has
// exactly one printing. Riftbound does: its commons and uncommons exist in both
// normal and foil, the foil slot is a real part of the pack, and the premium is
// large (Abandon is $0.27 normal, $3.18 foil), so those get a pricepoints call.
//
// WATCH OUT: a setName filter TCGplayer cannot match does not return nothing — it
// returns the ENTIRE product line. Set names holding a token that starts with a dash
// break it, because the dash is read as a NOT operator: "Premium Booster -The Best-"
// came back as all 6,804 One Piece cards and quietly rolled them into that one set.
// So the two non-Pokemon games no longer filter by set at all, and every Pokemon set
// is checked against the name the guide reports back.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LINES, HEADERS, search, searchBody, pricePoints, sleep, paced, currentPace, round2 } from "./lib.mjs";
import { variantOf, bucketKey, isJunk, summarize } from "./buckets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE = (id) => `https://infinite-api.tcgplayer.com/priceguide/set/${id}/cards/?rows=5000`;
const GH = { Accept: "application/json", "User-Agent": HEADERS["User-Agent"], Origin: "https://www.tcgplayer.com", Referer: "https://www.tcgplayer.com/" };
// 400px, not 1000px: these render as ~92px thumbnails and the big ones are 200 KB each.
const img = (id) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_400x400.jpg`;

/**
 * setId for a set name, returned only when the match is certain.
 * The filtered search is tried first; when it comes back describing a different set —
 * the dash bug — fall back to free text, which does not have the problem.
 */
async function setIdFor(line, setName) {
  const filtered = await search(searchBody(line, "Cards", { size: 1, setName }), { tag: setName });
  const hit = filtered.results?.[0];
  if (hit?.setName === setName) return { setId: hit.setId };

  await sleep(900);
  const loose = await search(searchBody(line, "Cards", { size: 50 }), { q: setName, tag: `${setName} (free text)` });
  const match = (loose.results || []).find((p) => p.setName === setName);
  return { setId: match?.setId ?? null };
}

// ---- Pokemon: whole set in one request, all printings ----
async function pokemonCards(setId, setName) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(GUIDE(setId), { headers: GH });
      if (r.ok) {
        const rows = (await r.json()).result || [];
        if (!rows.length) return null;
        // The guide names the set on every row, so a wrong setId cannot slip through.
        if (rows[0].set !== setName) throw new Error(`guide returned "${rows[0].set}"`);
        // Near Mint only. The condition string carries the printing for foils
        // ("Near Mint Reverse Holofoil"), so match the prefix, then trust `printing`.
        return rows
          .filter((x) => /^Near Mint/.test(x.condition || ""))
          .map((x) => ({
            id: x.productID, name: x.productName, number: x.number,
            rarity: x.rarity || "Unknown", printing: x.printing || "Normal",
            price: typeof x.marketPrice === "number" ? x.marketPrice : null,
          }));
      }
    } catch (e) {
      if (/guide returned/.test(e.message)) throw e;
    }
    await sleep(1500 * attempt);
  }
  return null;
}

// ---- One Piece / Riftbound: one pass over the whole line, then group by set ----
async function wholeLine(line) {
  const first = await search(searchBody(line, "Cards", { from: 0, size: 50 }), { tag: line });
  const total = first.totalResults || 0;
  let all = first.results || [];
  for (let from = 50; from < total; from += 50) {
    const r = await search(searchBody(line, "Cards", { from, size: 50 }), { tag: `${line}@${from}` });
    all = all.concat(r.results || []);
    if (from % 1000 < 50) process.stdout.write(`[${all.length}/${total} @${currentPace()}ms]`);
    await paced();
  }
  const bySet = new Map();
  for (const p of all) {
    if (!p.setName) continue;
    if (!bySet.has(p.setName)) bySet.set(p.setName, []);
    bySet.get(p.setName).push({
      id: p.productId, name: p.productName,
      number: p.customAttributes?.number || null,
      rarity: p.rarityName || "Unknown", printing: null,
      price: typeof p.marketPrice === "number" ? p.marketPrice : null,
    });
  }
  console.log(`\n  fetched ${all.length}/${total} cards across ${bySet.size} sets`);
  return bySet;
}

// Riftbound commons/uncommons come in both printings and the pack has a foil slot,
// so split them. Rare and above are foil-only — the search price is already right.
async function splitRiftboundFoils(cards) {
  const out = [];
  let done = 0;
  for (const c of cards) {
    if (!/^(common|uncommon)$/i.test(c.rarity)) { out.push({ ...c, printing: "Foil" }); continue; }
    const pp = await pricePoints(c.id);
    const norm = pp?.find((x) => x.printingType === "Normal")?.marketPrice ?? null;
    const foil = pp?.find((x) => x.printingType === "Foil")?.marketPrice ?? null;
    out.push({ ...c, printing: "Normal", price: norm ?? c.price });
    if (foil != null) out.push({ ...c, printing: "Foil", price: foil });
    if (++done % 25 === 0) process.stdout.write("f");
    await sleep(130);
  }
  return out;
}

function rollUp(cards, game) {
  const buckets = new Map();
  for (const c of cards) {
    const variant = variantOf(c.name, c.number, game);
    if (isJunk(c.rarity, variant)) continue;
    const printing = c.printing || "Normal";
    const key = bucketKey(c.rarity, printing, variant);
    if (!buckets.has(key)) buckets.set(key, { rarity: c.rarity, printing, variant, cards: [] });
    buckets.get(key).cards.push(c);
  }
  const list = [...buckets.values()]
    .map((b) => ({ rarity: b.rarity, printing: b.printing, variant: b.variant, ...summarize(b.cards) }))
    .sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));

  const top = cards
    .filter((c) => !isJunk(c.rarity, variantOf(c.name, c.number, game)) && typeof c.price === "number")
    .sort((a, b) => b.price - a.price)
    .slice(0, 15)
    .map((c) => ({
      id: c.id, name: c.name, num: c.number, rarity: c.rarity, printing: c.printing,
      variant: variantOf(c.name, c.number, game), price: round2(c.price),
      image: img(c.id), url: `https://www.tcgplayer.com/product/${c.id}`,
    }));

  return { buckets: list, top };
}

async function main() {
  const only = process.argv[2] || null; // optional game filter for quick reruns
  const sealed = JSON.parse(await readFile(join(ROOT, "data", "sealed.json"), "utf8"));
  const problems = [];

  for (const [game, line] of Object.entries(LINES)) {
    if (only && only !== game) continue;
    const sets = sealed.games[game] || [];
    const done = [];
    console.log(`\n===== ${game}: ${sets.length} sets =====`);

    // One line-wide pass for the games Infinite does not cover.
    const bySet = game === "pokemon" ? null : await wholeLine(line);

    for (const s of sets) {
      const t0 = Date.now();
      let cards = null;
      try {
        if (game === "pokemon") {
          const { setId } = await setIdFor(line, s.set);
          await sleep(450);
          if (!setId) throw new Error("could not resolve setId");
          cards = await pokemonCards(setId, s.set);
          if (!cards?.length) throw new Error("price guide empty");
        } else {
          cards = bySet.get(s.set) || null;
          if (!cards?.length) throw new Error("no cards in the line pass");
          if (game === "riftbound") cards = await splitRiftboundFoils(cards);
        }
      } catch (e) {
        problems.push(`${game} / ${s.set}: ${String(e.message || e).slice(0, 90)}`);
        console.log(`  !! ${s.set} — ${String(e.message || e).slice(0, 70)}`);
        await sleep(900);
        continue;
      }
      const { buckets, top } = rollUp(cards, game);
      done.push({ ...s, cards: cards.length, buckets, top });
      console.log(`  ${s.set} — ${cards.length} rows, ${buckets.length} buckets (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      if (game === "pokemon") await paced();
    }

    // Written per game, not at the very end: a throttle stall part way through One
    // Piece must not throw away an hour of Pokemon.
    await writeFile(
      join(ROOT, "data", `cards.${game}.json`),
      JSON.stringify({ updated: new Date().toISOString(), game, sets: done }, null, 1)
    );
    console.log(`  -> wrote data/cards.${game}.json (${done.length}/${sets.length} sets)`);
  }

  if (problems.length) console.log(`\n${problems.length} problems:\n` + problems.map((p) => "  - " + p).join("\n"));
  else console.log("\nNo problems.");
  console.log("Run scripts/merge.mjs to build data/cards.json.");
}
main().catch((e) => { console.error(e); process.exit(1); });
