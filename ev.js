// The EV model. Pure functions, no DOM, no fetch — the page and the build script
// run the same code so the published numbers and the numbers you get after editing
// a rate can never drift apart.
//
// EV(pack) = SUM over rates of  perPack x (average market price of the cards that rate can pull)
//
// Expectation is linear, so expressing odds as "expected cards per pack" makes this
// exact without having to model which slot produced what. Within a rate, a pull is
// assumed uniform over every card it can match — the standard assumption, and the
// main thing separating this from a number you could bet on.

export const FEE_RATE = 0.1325; // TCGplayer commission + payment processing, roughly

/** Does a bucket fall under this rate? An absent key in the match means "any". */
export function bucketMatches(bucket, match) {
  if (!match) return false;
  if (match.rarity && !match.rarity.includes(bucket.rarity)) return false;
  if (match.printing && !match.printing.includes(bucket.printing)) return false;
  if (match.variant && !match.variant.includes(bucket.variant)) return false;
  return true;
}

/**
 * Average price of one pull from the buckets a rate covers.
 * Buckets are weighted by how many cards they hold, because the pull is uniform
 * over cards, not over buckets. Cards with no market price are assumed to be worth
 * their bucket's average rather than zero — they are usually just cards that have
 * not sold yet, and calling them $0 would quietly understate every thin set.
 * `coverage` reports how much of the pool actually has a price so that assumption
 * stays visible.
 */
export function poolPrice(buckets, match) {
  const hit = buckets.filter((b) => bucketMatches(b, match));
  let weighted = 0;
  let weight = 0;
  let cards = 0;
  let priced = 0;
  for (const b of hit) {
    cards += b.n;
    priced += b.nPriced;
    if (b.avg == null) continue; // nothing in this bucket has sold; leave it out
    weighted += b.avg * b.n;
    weight += b.n;
  }
  return {
    price: weight ? weighted / weight : null,
    cards,
    priced,
    coverage: cards ? priced / cards : 0,
    buckets: hit.length,
  };
}

/**
 * Full EV for one set under one rate template.
 * `opts.netOfFees` values cards at what you would actually clear selling them.
 */
export function packEV(set, template, opts = {}) {
  const fee = opts.netOfFees ? 1 - FEE_RATE : 1;
  const lines = [];
  let ev = 0;
  let cardsPerPack = 0;

  for (const rate of template.rates) {
    const pool = poolPrice(set.buckets, rate.match);
    const perPack = typeof rate.perPack === "number" ? rate.perPack : 0;
    const value = pool.price == null ? 0 : pool.price * perPack * fee;
    ev += value;
    cardsPerPack += perPack;
    lines.push({
      label: rate.label,
      perPack,
      match: rate.match,
      poolPrice: pool.price == null ? null : pool.price * fee,
      value,
      cards: pool.cards,
      coverage: pool.coverage,
      // A rate that matches nothing means the set lacks that rarity — or that a
      // rarity name changed and the model is quietly losing value. Worth showing.
      empty: pool.buckets === 0,
    });
  }

  lines.sort((a, b) => b.value - a.value);
  const packsPerBox = template.packsPerBox || null;
  const packPrice = set.pack?.market ?? null;
  const boxPrice = set.box?.market ?? null;
  const boxEV = packsPerBox ? ev * packsPerBox : null;

  return {
    ev,
    boxEV,
    lines,
    cardsPerPack,
    packsPerBox,
    packPrice,
    boxPrice,
    // The number people actually want: what fraction of the pack price comes back.
    packReturn: packPrice ? ev / packPrice : null,
    boxReturn: boxPrice && boxEV ? boxEV / boxPrice : null,
    // Cheapest way in per pack — buying a box is usually less per pack than singles.
    boxPerPack: boxPrice && packsPerBox ? boxPrice / packsPerBox : null,
  };
}

/** Which era template applies to a set, by release date. */
export function templateFor(rates, game, release) {
  const rules = rates.assign[game] || [];
  const date = release || "1900-01-01";
  for (const r of rules) if (date >= r.from) return rates.templates[r.template];
  return rates.templates[rules[rules.length - 1]?.template] || null;
}

/** Days a set needs on shelves before its prices settle enough to trust. */
export const SETTLE_DAYS = 30;

/**
 * How much to trust a set's EV. Pull rates are the larger unknown, but a set whose
 * cards have barely sold yet is just as untrustworthy, so both are folded in here.
 */
export function confidenceOf(set, template, result, now = Date.now()) {
  const reasons = [];
  let level = template.confidence === "measured" ? "measured" : "estimated";

  // A set released days ago prices off a handful of listings, and those run far above
  // where the set settles once it is being opened in volume. Vendetta's commons
  // averaged $0.42 on release day against $0.06 for the set before it — that alone
  // moves the EV more than any pull rate does.
  const age = set.release ? (now - Date.parse(set.release)) / 86400000 : Infinity;
  if (age < SETTLE_DAYS) {
    level = "thin";
    reasons.push(
      age < 0
        ? "not released yet — prices are presale and mean little"
        : `released ${Math.max(0, Math.round(age))} days ago; launch prices run high and fall as the set is opened`
    );
  }

  // Weight coverage by how much value each line carries — thin commons matter little,
  // a thin chase bucket matters a lot.
  const total = result.lines.reduce((a, l) => a + l.value, 0);
  const covered = total
    ? result.lines.reduce((a, l) => a + l.value * l.coverage, 0) / total
    : 0;
  if (covered < 0.85) {
    level = "thin";
    reasons.push(`only ${Math.round(covered * 100)}% of the value-weighted card pool has sold yet`);
  }
  const missing = result.lines.filter((l) => l.empty && l.perPack >= 0.05);
  if (missing.length) {
    if (level === "measured") level = "estimated";
    reasons.push(`no cards found for: ${missing.map((l) => l.label).join(", ")}`);
  }

  // Most sets are missing a rarity or two their era had, which costs nothing.
  // But the odd special product — Celebrations, Detective Pikachu — shares almost
  // nothing with the era template it was matched to, and its EV comes out far too
  // low because most of the pack has nothing to price against. That is a bad fit,
  // not a thin market, and it deserves to be said out loud.
  const slots = result.lines.reduce((a, l) => a + l.perPack, 0);
  const lost = missing.reduce((a, l) => a + l.perPack, 0);
  if (slots > 0 && lost / slots > 0.25) {
    level = "thin";
    reasons.push(
      `${Math.round((lost / slots) * 100)}% of the pack has nothing to price — this set does not follow its era's structure, so the EV is understated`
    );
  }
  if (template.confidence !== "measured") {
    reasons.push(`odds are an era template (${template.sample}), not a study of this set`);
  } else {
    reasons.push(`odds from ${template.sample}`);
  }
  return { level, coverage: covered, reasons };
}
