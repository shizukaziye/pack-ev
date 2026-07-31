// Shared TCGplayer access: paced, retrying, and honest about failure.
export const SEARCH_API = "https://mp-search-api.tcgplayer.com/v1/search/request";
export const PRICEPOINTS = (id) => `https://mpapi.tcgplayer.com/v2/product/${id}/pricepoints`;

export const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Origin: "https://www.tcgplayer.com",
  Referer: "https://www.tcgplayer.com/",
};

export const LINES = {
  pokemon: "pokemon",
  onepiece: "one piece card game",
  riftbound: "riftbound: league of legends trading card game",
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// TCGplayer throttles by request rate, and when it does it 500s rather than 429s.
// Pushing harder makes it worse, so the pace adapts: every rejection widens the gap
// between requests and every clean run narrows it again. Without this a long paging
// job collapses into one retry storm and crawls.
let pace = 900;
const PACE_MIN = 700;
const PACE_MAX = 9000;
export const currentPace = () => pace;

// TCGplayer 429s hard and silently returns HTML. Back off long and loud.
export async function search(body, { q = "", tag = "" } = {}) {
  let lastErr = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await fetch(`${SEARCH_API}?q=${encodeURIComponent(q)}&isList=true`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        pace = Math.max(PACE_MIN, pace - 40); // earned back slowly
        return (await r.json()).results?.[0] || {};
      }
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = String(e).slice(0, 80);
    }
    pace = Math.min(PACE_MAX, Math.round(pace * 1.6));
    await sleep(pace * attempt);
  }
  throw new Error(`search failed after 6 tries ${tag}: ${lastErr}`);
}

/** Wait the current adaptive gap before the next search. */
export const paced = () => sleep(pace);

export async function pricePoints(id) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(PRICEPOINTS(id), { headers: HEADERS });
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(1200 * attempt);
  }
  return null;
}

export const searchBody = (line, type, { from = 0, size = 50, setName = null, aggregations = [] } = {}) => {
  const term = { productLineName: [line], productTypeName: [type] };
  if (setName) term.setName = [setName];
  return {
    algorithm: "sales_synonym_v2",
    from,
    size,
    filters: { term, range: {}, match: {} },
    listingSearch: { context: { cart: {} }, filters: { term: {}, range: {}, exclude: { channelExclusion: 0 } } },
    context: { cart: {}, shippingCountry: "US" },
    settings: { useFuzzySearch: false, didYouMean: {} },
    aggregations,
    sort: setName ? { field: "product-sorting-name", order: "asc" } : {},
  };
};
