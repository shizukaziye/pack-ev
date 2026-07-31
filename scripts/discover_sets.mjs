// Find every set that is still sold as a booster pack, and price its sealed products.
// Writes data/sealed.json: one record per set with pack / box / bundle / ETB prices.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LINES, search, searchBody, sleep, round2 } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Art bundles and multi-packs are not a single pack; sleeved packs are the same
// cards at a sleeve premium, so they get their own field rather than replacing pack.
const isPlainPack = (n) => /\bbooster pack\b/i.test(n) && !/\[set of|art bundle|sleeved/i.test(n);
const isSleevedPack = (n) => /sleeved booster pack/i.test(n) && !/\[set of|art bundle/i.test(n);
const isBox = (n) => /\bbooster box\b/i.test(n) && !/\bcase\b|\[set of/i.test(n);

async function sealedFor(line) {
  let all = [];
  for (let from = 0; from < 2000; from += 50) {
    const r = await search(searchBody(line, "Sealed Products", { from, size: 50 }), { tag: `${line} sealed@${from}` });
    const res = r.results || [];
    all = all.concat(res);
    process.stdout.write(".");
    if (res.length < 50 || all.length >= (r.totalResults || 0)) break;
    await sleep(1100);
  }
  return all;
}

async function main() {
  const out = {};
  for (const [key, line] of Object.entries(LINES)) {
    console.log(`\n=== ${key} ===`);
    const sealed = await sealedFor(line);
    console.log(` scanned ${sealed.length} sealed products`);

    const sets = new Map();
    const touch = (p) => {
      if (!sets.has(p.setName))
        sets.set(p.setName, { game: key, set: p.setName, setCode: p.setCode || null, release: null, pack: null, sleevedPack: null, box: null });
      const s = sets.get(p.setName);
      const rel = (p.customAttributes?.releaseDate || "").slice(0, 10);
      if (rel && (!s.release || rel < s.release)) s.release = rel;
      return s;
    };
    const rec = (p) => ({ id: p.productId, name: p.productName, market: round2(p.marketPrice), url: `https://www.tcgplayer.com/product/${p.productId}` });

    for (const p of sealed) {
      const n = p.productName || "";
      if (!p.setName) continue;
      if (isPlainPack(n)) touch(p).pack = rec(p);
      else if (isSleevedPack(n)) touch(p).sleevedPack = rec(p);
      else if (isBox(n)) touch(p).box = rec(p);
    }

    // A set qualifies only if you can actually buy a pack of it.
    const list = [...sets.values()]
      .filter((s) => s.pack || s.sleevedPack)
      .sort((a, b) => (b.release || "").localeCompare(a.release || ""));
    out[key] = list;
    console.log(` ${list.length} sets with a buyable pack`);
    for (const s of list) console.log(`   ${s.release || "????-??-??"} ${s.set} — pack $${s.pack?.market ?? "-"} box $${s.box?.market ?? "-"}`);
    await sleep(2000);
  }

  await writeFile(join(ROOT, "data", "sealed.json"), JSON.stringify({ updated: new Date().toISOString(), games: out }, null, 2));
  const total = Object.values(out).reduce((a, b) => a + b.length, 0);
  console.log(`\nWrote data/sealed.json — ${total} sets total`);
}
main().catch((e) => { console.error(e); process.exit(1); });
