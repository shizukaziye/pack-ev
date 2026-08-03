# Pack EV

A single static page that works out what the cards inside a booster pack are worth,
and sets that against what the pack costs. Covers every Pokémon, One Piece and
Riftbound set that TCGplayer still sells packs for. Prices refresh daily.

## The number

For each rarity the model holds an **expected number of cards per pack**. EV is the
sum over all of them:

```
EV = Σ (cards per pack × average market price of the cards that slot can give you)
```

Expectation is linear, so writing the odds this way makes the total exact without
having to guess how the pack's slots interact internally. It also matches how
community data is reported — "1 in 13 packs" is just `0.077` per pack.

Box EV is pack EV times the pack count. Box toppers and promos are not counted.

## Prices

Every card in every set, at its TCGplayer **market price**, Near Mint.

Three games, three routes, because TCGplayer does not treat them alike:

| Game | Source | Why |
| --- | --- | --- |
| Pokémon | Infinite price guide, one request per set | Names every printing, so a reverse holo is priced as a reverse holo |
| One Piece | Search API, paged | Infinite has no One Piece data; each rarity there has exactly one printing, so nothing more is needed |
| Riftbound | Search API + `pricepoints` per common/uncommon | Infinite has no Riftbound data, and its commons exist in both normal and foil — `Abandon` is $0.27 normal against $3.18 foil |

**Alternate arts are kept in their own buckets.** On TCGplayer an alt art carries its
base rarity: `Boa Hancock` is a Super Rare at $0.88 and `Boa Hancock (Alternate Art)`
is also a Super Rare at $58.11. Averaging those together would wreck the EV. Cards are
split by rarity **and** printing **and** variant, where the variant comes off the name
suffix, or off a collector number past the set size for the games that mark chase cards
that way (`301/298` overnumbered, `301*/298` signature).

## Odds

No publisher releases pull rates — not The Pokémon Company, not Bandai, not Riot.
What exists is counted packs, and how much has been counted differs sharply by game:

| Game | Per-set counts | Source |
| --- | --- | --- |
| Pokémon | 22 of 101 sets | TCGplayer's Authentication Center opens several thousand packs per set and publishes per-rarity odds with 95% confidence intervals |
| Riftbound | 3 of 4 sets | Release-window box openings; Spiritforged has none |
| One Piece | 18 of 21 sets | Case collation — 12 boxes to a case, each with known guaranteed hits — via tcgtrading.cards. Structural, not counted |

`scripts/pull_rates.mjs` pulls the Pokémon numbers straight from TCGplayer, finding
the articles by listing the editor who writes them, so a set published next month is
picked up without touching the code. `scripts/apply_collation.mjs` turns the One Piece
case-collation figures in `data/onepiece_collation.json` into per-set rates; that site
answers scripted requests with 429 whatever headers you send, so the figures are kept
in the repo and the file says how to refresh them from a browser. They are collation
constants, not prices, so they do not move day to day. Anything with no count of its own falls back to
an era template matched by release date (`assign` in `rates.json`).

**The card prices are firm and the odds are not**, and the odds dominate the answer.
Badges:

- **measured** — that set was counted, and the row links to the study
- **estimated** — odds borrowed from neighbouring sets
- **thin** — something else is wrong: the set is too new for prices to have settled,
  it doesn't follow its era's structure, or the study itself left a tier unmeasured

Two things are deliberately left alone rather than guessed. Sword & Shield articles
that split a Trainer Gallery subset out of the same Ultra Rare and Secret Rare buckets
give no way to divide the two, so those sets keep their era template. And Black Bolt's
Black White Rare — the most valuable card in the set — is listed as *unknown* even by
the people who counted the packs, so it gets a placeholder and the set gets flagged.

Any rate can be edited in an open row, and everything recalculates. Edits are in-page
only; reload restores the published numbers.

**Weights** sit next to the rates. A listed price is not always a realisable one —
thin markets floor commons at about what shipping costs, which is how a stack of
near-identical foils can price at more than its own pack. The weight column is the
share of a slot's listed price the total counts; set commons to 0% and bulk stops
counting everywhere at once, because weights key off the slot name and those names
are shared across all eleven templates. **Ignore bulk** does commons, uncommons,
reverse-holo and foil slots in one click.

The table switches between **per pack** and **per box**. Per box is usually the
fairer comparison: single packs carry a large markup over the same packs bought by
the box, and the box view's *per pack* column shows what a pack costs inside one.

## What the page won't tell you

- **The average is not the typical pack.** The *chase share* column shows how much of
  the EV rides on rarities appearing less than once in 20 packs. Where that is high,
  most packs come in far under EV.
- **Market price is not what you clear.** The fees switch takes 13.25% off, which is
  still optimistic — it ignores shipping, time and undercutting.
- **Opening a set pushes its own prices down.**
- **Sealed vintage is not an EV play.** Old packs trade on being sealed. A deeply
  negative return there is the right answer, not a bug.

## Files

```
index.html               the page; no build step, no dependencies
ev.js                    the model — pure functions, shared by the page and the QC script
data/sealed.json         sets that still sell packs, with pack and box prices
data/cards.json          every card rolled up into priced buckets, per set
data/rates.json          pull rates, sources and confidence per era template
scripts/discover_sets.mjs  finds which sets still sell packs
scripts/scrape_cards.mjs   prices every card and builds the buckets
scripts/qc.mjs             runs the model over the data and reports what looks wrong
scripts/lib.mjs            paced, retrying TCGplayer access
scripts/buckets.mjs        rarity/printing/variant classification
scripts/pull_rates.mjs     per-set Pokemon rates from TCGplayer's own studies
scripts/apply_collation.mjs  per-set One Piece rates from case collation
data/onepiece_collation.json  the collation figures, and how to refresh them
```

## Running it

```bash
node scripts/discover_sets.mjs   # which sets still sell packs
node scripts/scrape_cards.mjs    # price every card  (~10 min)
node scripts/qc.mjs              # check the model against the data
```

`scrape_cards.mjs` takes an optional game filter for quick reruns:
`node scripts/scrape_cards.mjs riftbound` writes `data/cards.riftbound.json`.

`.github/workflows/refresh.yml` runs all three daily at 12:00 UTC and commits the result.

## QC

`scripts/qc.mjs` is the check that the model is wired to the data correctly. The failure
mode that matters is a rate matching no bucket — a renamed rarity would silently drop
value and make every number too low without anything looking broken. It reports:

- rates that matched no cards
- rates summing to a different card count than the pack is meant to hold
- returns high enough to suggest a wrong rate
- rarities present in the data that no rate prices at all
