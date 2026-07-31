// A "bucket" is the unit the EV model prices: every card that a given pack slot
// could produce with equal chance. Rarity alone is not enough — on TCGplayer an
// alternate art carries its base rarity, so Boa Hancock SR ($0.88) and Boa Hancock
// (Alternate Art) SR ($58.11) would average together and wreck the number.

// Name suffixes that mark a card as a different pull than its plain print.
// Order matters — the first match wins, so the rarer treatment has to be tested
// before the plainer one it contains. "(Super Alternate Art)" must beat
// "alternate art" or a $4,800 Sabo lands in the same bucket as a $0.28 common
// rare and drags every average with it.
const VARIANT_TESTS = [
  [/\(ultimate\)/i, "ultimate"],
  [/\(signature\)/i, "signature"],
  [/\(box topper\)/i, "boxtopper"],
  [/\(manga\)|manga rare/i, "manga"],
  // One Piece's top treatments. The colour prefix is real: "(Red Super Alternate Art)".
  [/\((?:[a-z]+ )?super alternate art\)|\(wanted poster\)/i, "superalt"],
  [/\(alternate art\)|\(alt art\)|\(parallel\)/i, "alt"],
  [/\(overnumbered\)/i, "overnumbered"],
  [/\(sp\)|\(special\)/i, "special"],
];

// A collector number past the set size means different things in different games,
// so this rule is opt-in per game. In Riftbound 301/298 really is a rarer pull than
// the plain card. In Pokemon it is just how EVERY Illustration Rare, Special
// Illustration Rare, Ultra Rare and Hyper Rare is numbered — 238/191 is that card's
// only print. Applying the rule there put every valuable Pokemon rarity in an
// "overnumbered" bucket no rate matched, and quietly cut modern pack EV to a fifth
// of the truth.
const NUMBER_RULE_GAMES = new Set(["riftbound", "onepiece"]);

// One Piece reprint sets carry a stack of premium treatments that are separate
// products at wildly different prices — a Full Art common runs $65 where its plain
// reprint is 5 cents. Lumping them together made Premium Booster's commons average
// $5.35 and its pack EV read 347%.
//
// These are deliberately NOT applied to Pokemon: "(Full Art)" appears there too, but
// the rarity already separates those cards, and splitting them would strand every
// counted Ultra Rare rate against an empty bucket.
const ONEPIECE_TREATMENTS = [
  [/\(jolly roger foil\)/i, "jollyroger"],
  [/\(textured foil\)/i, "textured"],
  [/\(pirate foil\)/i, "pirate"],
  [/\(full art\)/i, "fullart"],
  [/\(gold\)|\(silver\)/i, "special"],
];

export function variantOf(name, number, game) {
  for (const [re, v] of VARIANT_TESTS) if (re.test(name || "")) return v;
  if (game === "onepiece") for (const [re, v] of ONEPIECE_TREATMENTS) if (re.test(name || "")) return v;
  if (NUMBER_RULE_GAMES.has(game)) {
    const m = /^(\d+)(\*?)\/(\d+)$/.exec((number || "").trim());
    if (m) {
      if (m[2] === "*") return "signature";
      if (Number(m[1]) > Number(m[3])) return "overnumbered";
    }
  }
  return "base";
}

export const bucketKey = (rarity, printing, variant) => `${rarity}|${printing}|${variant}`;

// Cards that never come out of a pack, so they have no place in a pack's EV.
// Code cards have no value; box toppers are real cards but come with the box.
export const isJunk = (rarity, variant) =>
  /^code card$/i.test(rarity || "") || variant === "boxtopper";

export function summarize(cards) {
  const priced = cards.filter((c) => typeof c.price === "number" && c.price > 0);
  const prices = priced.map((c) => c.price).sort((a, b) => a - b);
  const sum = prices.reduce((a, b) => a + b, 0);
  return {
    n: cards.length,
    nPriced: priced.length,
    avg: prices.length ? Math.round((sum / prices.length) * 1000) / 1000 : null,
    median: prices.length ? Math.round(prices[Math.floor(prices.length / 2)] * 1000) / 1000 : null,
    max: prices.length ? prices[prices.length - 1] : null,
  };
}
