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

Nobody publishes real pull rates — not The Pokémon Company, not Bandai, not Riot.
Everything in `data/rates.json` traces to community pack-opening counts, and each
template carries its sample size, its source and a confidence flag. **The card prices
are firm and the odds are not**, and the odds are what dominate the answer.

Sets are matched to an era template by release date (`assign` in `rates.json`). The
page shows one of three badges:

- **measured** — a counted study of that era
- **estimated** — an era template applied to a set nobody has counted
- **thin** — much of the set has not sold yet, so the prices themselves are shaky

Any rate can be edited in an open row, and everything recalculates. Edits are in-page
only; reload restores the published numbers.

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
