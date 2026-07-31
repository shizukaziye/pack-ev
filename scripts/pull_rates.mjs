// Per-set pull rates, straight from TCGplayer's own articles.
//
// The TCGplayer Authentication Center opens thousands of packs before a set's
// release and publishes the per-rarity odds with 95% confidence intervals. That is
// the best data anyone has, it covers most modern sets, and it comes from the same
// company as the prices — so a set with its own article should never be left on an
// era template. This pulls every one of those articles and writes the rates into
// data/rates.json under `setRates`, keyed by the set name the article itself
// carries, which matches the set names in the price data exactly.
//
// Sets with no article keep their era template and stay badged "estimated".

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HEADERS, sleep } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://infinite-api.tcgplayer.com/content";
const H = { Accept: "application/json", "User-Agent": HEADERS["User-Agent"], Origin: "https://www.tcgplayer.com", Referer: "https://www.tcgplayer.com/" };

// TCGplayer's rarity names on the left, this model's rate labels on the right.
// Some map to more than one candidate because the era templates name the tier
// differently; the first candidate the set's own template has wins.
const LABELS = {
  "double rare": ["Double Rare (ex)"],
  "ultra rare": ["Ultra Rare", "Ultra Rare (V / VMAX / full art)", "Ultra Rare (GX / full art)", "Ultra Rare (EX / full art)"],
  "illustration rare": ["Illustration Rare"],
  "special illustration rare": ["Special Illustration Rare"],
  "hyper rare": ["Hyper / Mega Hyper Rare", "Mega Hyper Rare", "Secret / Rainbow / Gold"],
  "mega hyper rare": ["Mega Hyper Rare", "Hyper / Mega Hyper Rare"],
  "mega attack rare": ["Mega Attack Rare"],
  "ace spec rare": ["ACE SPEC Rare"],
  "ace spec": ["ACE SPEC Rare"],
  "shiny rare": ["Shiny / other chase"],
  "shiny ultra rare": ["Shiny / other chase"],
  "black white rare": ["Shiny / other chase"],
  "radiant rare": ["Amazing / Radiant / ACE SPEC"],
  "rare holo": ["Rare (holo)", "Holo Rare"],
  "holo rare": ["Rare (holo)", "Holo Rare"],
  "secret rare": ["Secret / Rainbow / Gold", "Secret Rare"],
  "rainbow rare": ["Secret / Rainbow / Gold"],
  "prism rare": ["Prism Rare"],
  "amazing rare": ["Amazing / Radiant / ACE SPEC"],
};

// A few sets have a tier no era template knows about, so it needs its own rule as
// well as a rate. Prismatic Evolutions is the case that matters: its Poké Ball and
// Master Ball foils turn up in more than a third of packs and are worth ~18x the
// plain print, but TCGplayer's price guide files both under plain "Holofoil", so
// they share one bucket and their rates add together.
const EXTRA_RATES = {
  "pok ball foil": {
    label: "Poké Ball / Master Ball foil",
    match: { rarity: ["Common", "Uncommon"], printing: ["Holofoil"], variant: ["base"] },
  },
  "master ball foil": {
    label: "Poké Ball / Master Ball foil",
    match: { rarity: ["Common", "Uncommon"], printing: ["Holofoil"], variant: ["base"] },
  },
};

// Sword & Shield era articles are laid out by sub-rarity rather than by the rarity
// TCGplayer files the card under, and some rows are subsets of the row above. Those
// sets only ever have three hit rarities in the price data — Ultra Rare, Secret Rare
// and Radiant Rare — so the sub-rows have to be folded back together before use.
const UR_UMBRELLA = "ultra rare";
const UR_SUBROWS = new Set([
  "normal pokmon v", "normal pokmon vmax", "pokmon vmax or vstar", "fullart pokmon v",
  "fullart trainer", "full art trainer", "altart pokmon v", "altart pokmon vmax", "fullart",
]);
const SECRET_ROWS = new Set(["secret rare", "rainbow rare", "gold rare", "gold"]);
// A Gallery subset is drawn from the very same Ultra Rare and Secret Rare buckets as
// the rows above it, and nothing in the data says how the two split. Guessing would
// be worse than leaving the set on its era template, so these sets are skipped.
const GALLERY_ROWS = new Set(["trainer gallery", "galarian gallery"]);

/** Fold a Sword & Shield era table into this model's three hit tiers. */
function foldSwshTable(table) {
  const keys = Object.keys(table);
  if (keys.some((k) => GALLERY_ROWS.has(k))) return { skip: "table splits a Gallery subset out of the same buckets" };
  const out = {};
  const ur = table[UR_UMBRELLA] ?? keys.filter((k) => UR_SUBROWS.has(k)).reduce((a, k) => a + table[k], 0);
  if (ur > 0) out["Ultra Rare (V / VMAX / full art)"] = Number(ur.toFixed(4));
  const secret = keys.filter((k) => SECRET_ROWS.has(k)).reduce((a, k) => a + table[k], 0);
  if (secret > 0) out["Secret / Rainbow / Gold"] = Number(secret.toFixed(4));
  if (table["radiant rare"]) out["Amazing / Radiant / ACE SPEC"] = table["radiant rare"];
  return { rates: out };
}

const isSwshStyle = (table) =>
  Object.keys(table).some((k) => UR_SUBROWS.has(k) || GALLERY_ROWS.has(k));

async function get(url) {
  for (let a = 1; a <= 4; a++) {
    try {
      const r = await fetch(url, { headers: H });
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(1200 * a);
  }
  return null;
}

// TCGplayer writes all of these, and one editor writes all of TCGplayer's, so the
// whole back catalogue comes from listing that author. `/content/articles/search/`
// ignores its own query parameter and answers with unrelated Magic articles;
// `/c/articles/?authors=<uuid>` is the one that works. Doing it this way means a
// set published next month is picked up without editing anything here.
const ALSO_COVERS = { "Black Bolt and White Flare": "SV: White Flare" };

const AUTHOR = "2aa24c40-a53f-4f2b-ac83-a82f747fca5e"; // Peter Day, TCGplayer Infinite

async function listByAuthor() {
  const found = new Map();
  for (let offset = 0; offset < 600; offset += 100) {
    const j = await get(`https://infinite-api.tcgplayer.com/c/articles/?source=infinite-content&authors=${AUTHOR}&rows=100&offset=${offset}`);
    const rows = j?.result || [];
    for (const r of rows) if (/pull rates/i.test(r.title || "")) found.set(r.uuid, r.title);
    if (rows.length < 100) break;
    await sleep(400);
  }
  return [...found.keys()];
}

// Anything the author listing misses can be pinned here by id. The set a rate is
// filed under always comes from the article itself, never from this list, so a
// wrong id cannot quietly attach rates to the wrong set.
const EXTRA_ARTICLES = [
  "069a5fda-2d1f-44a1-97de-b6dcdc5abfb8", // Pitch Black
  "304e8bfc-175a-4d31-93fe-5bb1be11e5d2", // Chaos Rising
  "73148119-ebcb-40b7-84b6-52b3a6d0c631", // Perfect Order
  "60143d94-88a7-42ce-8e73-babd7b3fabd6", // Ascended Heroes
  "9abae60d-b7fb-448f-874e-176f78d6a6ca", // Phantasmal Flames
  "40cbeedc-21ce-473b-aef1-74e3969d9f91", // Mega Evolution
  "43ba832e-44c9-45a4-ae2e-594df2defdda", // Destined Rivals
  "1b9f379f-97cb-45cc-b6f6-a1a070a422cd", // Journey Together
  "d94889ea-f76a-4a13-b74d-5b0b071220a7", // Prismatic Evolutions
  "6ccfb6ab-f26a-4ce8-bab5-5f91c85ec70e", // Surging Sparks
  "2c0743dd-dbd0-4504-9ff8-be5a72dd04d1", // Stellar Crown
  "f3eea967-e5fb-4108-8655-bb1c89587628", // Twilight Masquerade
  "28c0ad22-00a4-428f-b22d-e7fee9ec50bc", // Temporal Forces
  "23de3e93-0d0f-4ae0-abc4-13664f3001a3", // Paldean Fates
  "0b5fb648-38fc-4f61-a6af-57c2737b4a48", // Paradox Rift
  "e2a66999-a7b5-4621-9765-c9a132e04bd2", // Obsidian Flames
  "1b7d3e70-9542-4a50-8692-1661e2316521", // Paldea Evolved
  "a7702fce-dd64-4a58-beb1-0f871c853215", // Scarlet & Violet base
  "ba20ac4d-9448-45ce-b919-d856d107c744", // Lost Origin
  "bac92199-a2a7-4668-b4a4-2647a111776f", // Black Bolt and White Flare (one article, two sets)
  "b237df74-fbb0-40d0-9e13-d69ee6e804d9", // Scarlet & Violet 151
  "56af3032-cb34-4da1-92fb-9cf206d10c0f", // Crown Zenith
];

/** Fetch each article and let it say which set it covers. */
async function findArticles() {
  const discovered = await listByAuthor();
  const uuids = [...new Set([...discovered, ...EXTRA_ARTICLES])];
  console.log(`  ${discovered.length} found by author listing, ${uuids.length} to read in total.`);
  const found = [];
  for (const uuid of uuids) {
    const j = await get(`${API}/article/${uuid}/`);
    const a = j?.result?.article;
    if (!a) { console.log(`  ! ${uuid} — could not fetch`); continue; }
    const sets = [...(a.setName || [])];
    // "Black Bolt and White Flare Pull Rates" is tagged with Black Bolt alone, but
    // the rates it reports are for both sets — they share a print run and structure.
    for (const [inTitle, alsoCovers] of Object.entries(ALSO_COVERS))
      if (a.title.includes(inTitle) && !sets.includes(alsoCovers)) sets.push(alsoCovers);
    if (!sets.length) { console.log(`  ! "${a.title}" — article names no set`); continue; }
    for (const set of sets) found.push({ set, uuid, title: a.title, body: a.body });
    await sleep(350);
  }
  return found;
}

const strip = (h) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * Pull the per-rarity summary out of an article.
 *
 * Not simply the first table: several articles open with a table comparing this
 * set against the last few, whose first column is set names rather than rarities.
 * Taking that one produced rows like "paldea evolved sirs". So read every table
 * and keep the one whose first heading is "Rarity".
 */
function parseTable(body) {
  const tables = (body || "").match(/<table[^>]*>[\s\S]*?<\/table>/gi) || [];
  let best = null;
  for (const tbl of tables) {
    const rows = tbl.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    if (!rows.length) continue;
    const head = (rows[0].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || []).map((c) => strip(c).toLowerCase());
    // "Rarity", but also "Rarity/Printing" where a set has special foil treatments.
    // "Rarity", "Rarity/Printing", and the older "Card Rarity" / "Card Type" / "Subrarity".
    if (!/^(rarity|card rarity|card type|subrarity)\b/.test(head[0] || "")) continue;

    const out = {};
    for (const row of rows.slice(1)) {
      const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || []).map((c) => strip(c));
      if (cells.length < 2) continue;
      const rarity = cells[0].toLowerCase().replace(/[^a-z ]/g, "").trim();
      // "19.83% ± 0.84%" — the first percentage is the rate; the second is the interval.
      // TCGplayer sometimes prints "Unknown" for a tier it could not measure — the
      // Black White Rare in Black Bolt is one. Keeping a note of that matters more
      // than the missing number: it is the set's biggest card.
      if (/unknown/i.test(cells[1])) { out[rarity] = null; continue; }
      const pct = /(\d+(?:\.\d+)?)\s*%/.exec(cells[1]);
      if (!pct) continue;
      const perPack = Number(pct[1]) / 100;
      if (perPack > 0 && perPack <= 1) out[rarity] = perPack;
    }
    // Prefer the fullest summary table when an article has more than one.
    const real = Object.values(out).filter((v) => v != null).length;
    if (real && (!best || real > Object.values(best).filter((v) => v != null).length)) best = out;
  }
  return best;
}

const sampleOf = (body) => {
  const m = /(?:opened|opening)\s+(?:more than|over|nearly|about)?\s*([\d,]{3,})\s+booster packs/i.exec(strip(body));
  return m ? `${m[1]} packs opened by the TCGplayer Authentication Center` : "TCGplayer Authentication Center";
};

async function main() {
  const rates = JSON.parse(await readFile(join(ROOT, "data", "rates.json"), "utf8"));
  const cards = JSON.parse(await readFile(join(ROOT, "data", "cards.json"), "utf8"));
  const known = new Set(cards.games.pokemon.map((s) => s.set));

  // Which rate labels each set's era template offers, so a rarity can be mapped
  // onto the right one.
  const labelsFor = (setName) => {
    const s = cards.games.pokemon.find((x) => x.set === setName);
    const rules = rates.assign.pokemon || [];
    const date = s?.release || "1900-01-01";
    for (const r of rules) if (date >= r.from) return rates.templates[r.template].rates.map((x) => x.label);
    return [];
  };

  console.log("Searching TCGplayer for pull-rate articles…");
  const articles = await findArticles();
  console.log(`Found ${articles.length} Pokemon pull-rate articles.\n`);

  // Rebuilt each run so a pulled article cannot leave a stale entry behind — but
  // hand-entered rates for the other two games are not this script's to delete.
  const keep = Object.entries(rates.setRates || {}).filter(
    ([, v]) => v.manual || !/tcgplayer\.com/.test(v.source || "")
  );
  const setRates = Object.fromEntries(keep);
  const manual = new Set(keep.filter(([, v]) => v.manual).map(([k]) => k));
  const unmapped = new Map();
  let wrote = 0, skipped = 0;

  for (const a of articles) {
    if (!known.has(a.set)) { console.log(`  – ${a.set} — no priced set by that name, skipping`); skipped++; continue; }
    if (manual.has(a.set)) { console.log(`  = ${a.set} — keeping hand-counted rates`); skipped++; continue; }
    const body = a.body;
    const table = parseTable(body);
    if (!table) { console.log(`  ! ${a.set} — no table found`); skipped++; continue; }

    // Fold the older sub-rarity layout back into this model's tiers first.
    let rows = table;
    if (isSwshStyle(table)) {
      const folded = foldSwshTable(table);
      if (folded.skip) { console.log(`  – ${a.set} — ${folded.skip}`); skipped++; continue; }
      rows = null;
      var preMapped = folded.rates;
    }

    const have = labelsFor(a.set);
    const mapped = rows === null ? { ...preMapped } : {};
    const extraMatch = {};
    const unknown = [];
    for (const [rarity, perPack] of Object.entries(rows || {})) {
      if (perPack == null) { unknown.push(rarity); continue; }
      const label = (LABELS[rarity] || []).find((l) => have.includes(l));
      if (label) { mapped[label] = perPack; continue; }
      const extra = EXTRA_RATES[rarity];
      if (extra) {
        // Two rows can feed one bucket, so add rather than overwrite.
        mapped[extra.label] = (mapped[extra.label] || 0) + perPack;
        extraMatch[extra.label] = extra.match;
        continue;
      }
      unmapped.set(rarity, (unmapped.get(rarity) || 0) + 1);
    }
    // A tier TCGplayer could not measure still has to be priced at something, and
    // the era template's guess is usually far too generous — it had the Black White
    // Rare, a ~$600 card, at 1 in 50 packs. Drop it to the order of magnitude the
    // measured top-chase tiers actually sit at (Mega Hyper is 1 in ~1,100) and make
    // the set say out loud that this number is not counted.
    for (const rarity of unknown) {
      const label = (LABELS[rarity] || []).find((l) => have.includes(l));
      if (label && mapped[label] == null) mapped[label] = 0.001;
    }

    if (!Object.keys(mapped).length) { console.log(`  ! ${a.set} — nothing mapped`); skipped++; await sleep(400); continue; }

    setRates[a.set] = {
      confidence: "measured",
      sample: sampleOf(body),
      source: `https://www.tcgplayer.com/content/article/${encodeURIComponent(a.title.replace(/[:\s]+/g, "-"))}/${a.uuid}/`,
      rates: mapped,
      ...(unknown.length ? { unknown } : {}),
      ...(Object.keys(extraMatch).length ? { match: extraMatch } : {}),
    };
    wrote++;
    console.log(`  ✓ ${a.set.padEnd(34)} ${Object.entries(mapped).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  }

  rates.setRates = setRates;
  await writeFile(join(ROOT, "data", "rates.json"), JSON.stringify(rates, null, 2));
  console.log(`\nWrote per-set rates for ${wrote} sets (${skipped} skipped).`);
  if (unmapped.size) {
    console.log("Rarity names with no matching rate label (value would be lost):");
    for (const [r, n] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${r} (${n} sets)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
