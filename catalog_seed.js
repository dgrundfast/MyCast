/* =============================================================================
   True Scope — Catalog Seed Config
   =============================================================================
   Drop-in seed for the `topics` table + the guided-picker taxonomy.

   THREE KINDS OF PICKABLE THINGS:
     1. CATEGORIES  — ~30 standing topics, always live, generated every cycle.
     2. TEAMS       — generated from league rosters (ESPN), created on demand
                      when a user first picks one. Shared thereafter.
     3. CITIES      — metro news topics, created on demand. Shared thereafter.
     4. FOLLOWS     — companies / public figures, created on demand. Shared.

   Categories are ALWAYS generated (they're the free-tier menu). Teams, cities,
   and follows are created lazily (first subscriber seeds them) and retired when
   subscriber_count hits 0 — this is the flywheel.

   WINDOW TUNING (window_hours) — this is what fixes the "no news" bug:
     24h  fast cycle (world, politics, markets)
     48h  medium    (tech, sports, entertainment)  ← sports MUST be 48h so a
                                                     10pm game is in the 6am brief
     72h  slow      (science, health, climate)     ← 24h is why these felt thin
   ========================================================================== */

/* ---------------------------------------------------------------------------
   1. CURATED CATEGORIES (~30) — the always-on menu
   ------------------------------------------------------------------------ */
const CATEGORIES = {
  /* ---- Core news ---- */
  world_news: {
    label: 'World News',
    window_hours: 24,
    queries: ['world news', 'international news today', 'global headlines', 'breaking world news'],
    rss: [
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
      'https://feeds.npr.org/1004/rss.xml',
      'https://www.theguardian.com/world/rss',
      'https://www.aljazeera.com/xml/rss/all.xml',
    ],
  },
  us_news: {
    label: 'US News',
    window_hours: 24,
    queries: ['US news today', 'national news', 'America headlines', 'top US stories'],
    rss: [
      'https://feeds.npr.org/1003/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/US.xml',
      'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
    ],
  },
  us_politics: {
    label: 'US Politics',
    window_hours: 24,
    queries: ['US politics', 'Congress', 'White House', 'Washington politics today', 'Senate House vote'],
    rss: [
      'https://feeds.npr.org/1014/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
      'https://thehill.com/homenews/feed/',
      'https://www.politico.com/rss/politicopicks.xml',
    ],
  },
  elections: {
    label: 'Elections',
    window_hours: 48,
    queries: ['election news', 'campaign 2026', 'polls candidates', 'primary results'],
    rss: [
      'https://feeds.npr.org/1014/rss.xml',
      'https://thehill.com/homenews/campaign/feed/',
    ],
  },

  /* ---- Money ---- */
  markets_finance: {
    label: 'Markets & Finance',
    window_hours: 24,
    finance: true,
    queries: ['stock market today', 'Federal Reserve', 'S&P 500', 'bond yields', 'market close'],
    rss: [
      'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
      'https://feeds.bbci.co.uk/news/business/rss.xml',
      'https://feeds.marketwatch.com/marketwatch/topstories/',
    ],
  },
  business: {
    label: 'Business',
    window_hours: 24,
    queries: ['business news', 'corporate earnings', 'mergers acquisitions', 'CEO company news'],
    rss: [
      'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
      'https://feeds.npr.org/1006/rss.xml',
      'https://www.theguardian.com/business/rss',
    ],
  },
  economy: {
    label: 'Economy',
    window_hours: 48,
    finance: true,
    queries: ['economy news', 'inflation CPI', 'jobs report unemployment', 'GDP growth', 'interest rates'],
    rss: [
      'https://feeds.npr.org/1017/rss.xml',
      'https://www.theguardian.com/business/economics/rss',
    ],
  },
  crypto: {
    label: 'Crypto',
    window_hours: 24,
    finance: true,
    queries: ['cryptocurrency news', 'bitcoin price', 'ethereum crypto regulation', 'digital assets'],
    rss: ['https://www.coindesk.com/arc/outboundfeeds/rss/'],
  },
  startups_vc: {
    label: 'Startups & VC',
    window_hours: 48,
    queries: ['startup funding', 'venture capital round', 'tech startup news', 'IPO'],
    rss: ['https://techcrunch.com/feed/'],
  },
  real_estate: {
    label: 'Real Estate & Housing',
    window_hours: 72,
    queries: ['housing market', 'mortgage rates', 'real estate news', 'home prices'],
    rss: ['https://rss.nytimes.com/services/xml/rss/nyt/RealEstate.xml'],
  },
  personal_finance: {
    label: 'Personal Finance',
    window_hours: 72,
    queries: ['personal finance', 'retirement savings', 'consumer money tips', 'credit debt'],
    rss: ['https://feeds.marketwatch.com/marketwatch/topstories/'],
  },

  /* ---- Tech ---- */
  technology: {
    label: 'Technology',
    window_hours: 48,
    queries: ['technology news', 'tech industry', 'gadgets devices', 'big tech'],
    rss: [
      'https://feeds.arstechnica.com/arstechnica/index/',
      'https://www.theverge.com/rss/index.xml',
      'https://techcrunch.com/feed/',
      'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
      'https://feeds.bbci.co.uk/news/technology/rss.xml',
    ],
  },
  ai: {
    label: 'AI',
    window_hours: 48,
    queries: ['artificial intelligence news', 'AI models', 'machine learning', 'OpenAI Anthropic Google AI', 'AI regulation'],
    rss: [
      'https://feeds.arstechnica.com/arstechnica/index/',
      'https://www.theverge.com/rss/index.xml',
      'https://techcrunch.com/feed/',
    ],
  },
  cybersecurity: {
    label: 'Cybersecurity',
    window_hours: 48,
    queries: ['cybersecurity breach', 'hacking ransomware', 'data breach', 'security vulnerability'],
    rss: [
      'https://feeds.arstechnica.com/arstechnica/index/',
      'https://krebsonsecurity.com/feed/',
    ],
  },
  gaming: {
    label: 'Gaming',
    window_hours: 48,
    queries: ['video game news', 'gaming industry', 'game release', 'console PC games'],
    rss: [
      'https://www.theverge.com/rss/index.xml',
      'https://www.polygon.com/rss/index.xml',
    ],
  },
  space: {
    label: 'Space',
    window_hours: 72,
    queries: ['space news', 'NASA SpaceX launch', 'astronomy discovery', 'satellite mission'],
    rss: [
      'https://www.space.com/feeds/all',
      'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml',
    ],
  },

  /* ---- Science / Health / Planet (slow cycle — 72h) ---- */
  science: {
    label: 'Science',
    window_hours: 72,
    queries: ['science research', 'scientific discovery', 'new study findings', 'physics biology'],
    rss: [
      'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml',
      'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
      'https://www.sciencedaily.com/rss/all.xml',
      'https://feeds.npr.org/1007/rss.xml',
    ],
  },
  health: {
    label: 'Health & Medicine',
    window_hours: 72,
    queries: ['health news', 'medical research', 'public health', 'FDA drug approval', 'disease outbreak'],
    rss: [
      'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml',
      'https://feeds.bbci.co.uk/news/health/rss.xml',
      'https://feeds.npr.org/1128/rss.xml',
    ],
  },
  climate: {
    label: 'Climate & Environment',
    window_hours: 72,
    queries: ['climate change', 'environment news', 'emissions policy', 'extreme weather climate'],
    rss: [
      'https://www.theguardian.com/environment/climate-crisis/rss',
      'https://rss.nytimes.com/services/xml/rss/nyt/Climate.xml',
      'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    ],
  },
  energy: {
    label: 'Energy',
    window_hours: 48,
    queries: ['energy news', 'oil gas prices', 'renewable energy solar wind', 'electric grid'],
    rss: ['https://www.theguardian.com/environment/energy/rss'],
  },

  /* ---- Sports (48h — CRITICAL: night games must land in morning briefs) ---- */
  sports: {
    label: 'Sports',
    window_hours: 48,
    sports: true,
    queries: ['sports news today', 'game results last night', 'sports headlines', 'scores recap'],
    rss: [
      'https://www.espn.com/espn/rss/news',
      'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml',
      'https://feeds.bbci.co.uk/sport/rss.xml',
      'https://www.theguardian.com/sport/rss',
    ],
  },
  nfl: {
    label: 'NFL',
    window_hours: 48,
    sports: true,
    queries: ['NFL news', 'NFL scores recap', 'NFL injuries trades'],
    rss: ['https://www.espn.com/espn/rss/nfl/news'],
  },
  nba: {
    label: 'NBA',
    window_hours: 48,
    sports: true,
    queries: ['NBA news', 'NBA scores last night', 'NBA trades injuries'],
    rss: ['https://www.espn.com/espn/rss/nba/news'],
  },
  mlb: {
    label: 'MLB',
    window_hours: 48,
    sports: true,
    queries: ['MLB news', 'baseball scores last night', 'MLB trades injuries'],
    rss: ['https://www.espn.com/espn/rss/mlb/news'],
  },
  nhl: {
    label: 'NHL',
    window_hours: 48,
    sports: true,
    queries: ['NHL news', 'hockey scores last night', 'NHL trades injuries'],
    rss: ['https://www.espn.com/espn/rss/nhl/news'],
  },
  soccer: {
    label: 'Soccer',
    window_hours: 48,
    sports: true,
    queries: ['soccer news', 'Premier League results', 'Champions League', 'football transfer news'],
    rss: [
      'https://www.espn.com/espn/rss/soccer/news',
      'https://www.theguardian.com/football/rss',
    ],
  },
  college_sports: {
    label: 'College Sports',
    window_hours: 48,
    sports: true,
    queries: ['college football news', 'college basketball', 'NCAA results'],
    rss: ['https://www.espn.com/espn/rss/ncf/news'],
  },

  /* ---- Culture ---- */
  entertainment: {
    label: 'Entertainment',
    window_hours: 48,
    queries: ['entertainment news', 'movies film', 'music industry', 'celebrity news'],
    rss: [
      'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml',
      'https://www.theguardian.com/culture/rss',
    ],
  },
  streaming_tv: {
    label: 'Streaming & TV',
    window_hours: 48,
    queries: ['streaming news Netflix', 'TV shows premiere', 'HBO Disney Apple TV'],
    rss: ['https://www.theverge.com/rss/index.xml'],
  },
  books_ideas: {
    label: 'Books & Ideas',
    window_hours: 72,
    queries: ['book news', 'author interview', 'publishing literature'],
    rss: ['https://rss.nytimes.com/services/xml/rss/nyt/Books.xml'],
  },

  /* ---- Life ---- */
  travel: {
    label: 'Travel',
    window_hours: 72,
    queries: ['travel news', 'airline flights', 'destinations tourism'],
    rss: ['https://rss.nytimes.com/services/xml/rss/nyt/Travel.xml'],
  },
  food: {
    label: 'Food & Dining',
    window_hours: 72,
    queries: ['food news', 'restaurants dining', 'recipes cooking trends'],
    rss: ['https://rss.nytimes.com/services/xml/rss/nyt/DiningandWine.xml'],
  },
  autos: {
    label: 'Autos & EVs',
    window_hours: 48,
    queries: ['auto industry news', 'electric vehicles EV', 'car reviews Tesla'],
    rss: ['https://www.theverge.com/rss/index.xml'],
  },
};

/* ---------------------------------------------------------------------------
   2. PICKER TAXONOMY — teams / cities / follows
   These are NOT pre-generated. They're created on first subscribe, then shared.
   ------------------------------------------------------------------------ */

// Teams: pulled live from ESPN league rosters, so the picker is always current.
// A team topic is created when its first subscriber picks it.
const TEAM_LEAGUES = [
  { key: 'mlb', label: 'MLB',    sport: 'baseball',   league: 'mlb'   },
  { key: 'nba', label: 'NBA',    sport: 'basketball', league: 'nba'   },
  { key: 'nfl', label: 'NFL',    sport: 'football',   league: 'nfl'   },
  { key: 'nhl', label: 'NHL',    sport: 'hockey',     league: 'nhl'   },
  { key: 'epl', label: 'Premier League', sport: 'soccer', league: 'eng.1' },
];

// Template used when a team topic is created (see §5.2 of the spec).
function teamTopic(league, team) {
  return {
    id: `${league.key}_${slug(team.name)}`,          // e.g. mlb_dodgers
    kind: 'team',
    label: team.displayName,                          // "Los Angeles Dodgers"
    norm_key: `${league.key}:${slug(team.shortName)}`, // mlb:dodgers  ← dedupe key
    window_hours: 48,                                  // night games!
    sports: true,
    queries: [
      team.displayName,
      `${team.displayName} game recap`,
      `${team.displayName} news`,
      `${team.shortName} score last night`,
      `${league.label} ${team.shortName}`,
    ],
    rss: CATEGORIES[league.key] ? CATEGORIES[league.key].rss : CATEGORIES.sports.rss,
    espn: { sport: league.sport, league: league.league, teamId: team.id },
  };
}

// Cities: metro news. Start with the top ~40 US metros; add on request.
const CITIES = [
  'New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia',
  'San Antonio', 'San Diego', 'Dallas', 'Austin', 'San Jose', 'Jacksonville',
  'Fort Worth', 'Columbus', 'Charlotte', 'Indianapolis', 'San Francisco',
  'Seattle', 'Denver', 'Washington DC', 'Boston', 'Nashville', 'Detroit',
  'Portland', 'Las Vegas', 'Memphis', 'Louisville', 'Baltimore', 'Milwaukee',
  'Atlanta', 'Miami', 'Minneapolis', 'New Orleans', 'Cleveland', 'Tampa',
  'Pittsburgh', 'Cincinnati', 'Kansas City', 'St. Louis', 'Salt Lake City',
];

function cityTopic(city) {
  return {
    id: `city_${slug(city)}`,
    kind: 'city',
    label: `${city} News`,
    norm_key: `city:${slug(city)}`,
    window_hours: 48,
    queries: [
      `${city} news`,
      `${city} local news today`,
      `${city} city council`,
      `${city} breaking`,
    ],
    rss: [], // local RSS varies; rely on search providers + NewsData geo
    geo: city,
  };
}

// Follows: companies + public figures. Searchable list; created on subscribe.
const FOLLOW_SEEDS = {
  companies: [
    'Apple', 'Microsoft', 'Google', 'Amazon', 'Meta', 'Tesla', 'Nvidia',
    'OpenAI', 'Anthropic', 'Netflix', 'Disney', 'Boeing', 'JPMorgan',
    'Goldman Sachs', 'Walmart', 'Ford', 'GM', 'Intel', 'AMD', 'SpaceX',
  ],
  institutions: [
    'Federal Reserve', 'Supreme Court', 'Congress', 'NATO', 'European Union',
    'United Nations', 'SEC', 'FDA', 'FTC',
  ],
};

function followTopic(name, kind) {
  return {
    id: `follow_${slug(name)}`,
    kind: 'follow',
    label: name,
    norm_key: `follow:${slug(name)}`,
    window_hours: 48,
    queries: [name, `${name} news`, `${name} announcement`, `${name} latest`],
    rss: [],
  };
}

/* ---------------------------------------------------------------------------
   3. NORMALIZATION — the de-dupe that makes the flywheel work
   "LA Dodgers" / "Dodgers" / "los angeles dodgers"  ->  mlb:dodgers
   A weak normalizer fragments the cache and you pay repeatedly for the same
   topic. This is the highest-leverage 50 lines in the codebase.
   ------------------------------------------------------------------------ */
const ALIASES = {
  // teams (city + nickname variants -> canonical)
  'la dodgers': 'mlb:dodgers', 'los angeles dodgers': 'mlb:dodgers', 'dodgers': 'mlb:dodgers',
  'boston red sox': 'mlb:redsox', 'red sox': 'mlb:redsox', 'bosox': 'mlb:redsox',
  'ny yankees': 'mlb:yankees', 'new york yankees': 'mlb:yankees', 'yankees': 'mlb:yankees',
  'boston celtics': 'nba:celtics', 'celtics': 'nba:celtics',
  'la lakers': 'nba:lakers', 'los angeles lakers': 'nba:lakers', 'lakers': 'nba:lakers',
  'ne patriots': 'nfl:patriots', 'new england patriots': 'nfl:patriots', 'patriots': 'nfl:patriots',
  // ...extend from ESPN roster at seed time (auto-generate city+nickname variants)

  // companies
  'alphabet': 'follow:google', 'google': 'follow:google',
  'facebook': 'follow:meta', 'meta': 'follow:meta',
  'x': 'follow:twitter', 'twitter': 'follow:twitter',

  // topic synonyms
  'ai': 'ai', 'artificial intelligence': 'ai', 'machine learning': 'ai',
  'crypto': 'crypto', 'cryptocurrency': 'crypto', 'bitcoin': 'crypto',
  'stocks': 'markets_finance', 'stock market': 'markets_finance', 'wall street': 'markets_finance',
  'the fed': 'follow:federal reserve', 'fed': 'follow:federal reserve',
};

const STOPWORDS = new Set(['the', 'a', 'an', 'news', 'latest', 'updates', 'about', 'on', 'my']);

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function normalizeTopic(raw) {
  let t = String(raw).toLowerCase().trim()
    .replace(/[^\w\s&.-]/g, ' ')         // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();

  // strip leading stopwords ("the dodgers" -> "dodgers")
  t = t.split(' ').filter(w => !STOPWORDS.has(w)).join(' ').trim();

  // direct alias hit
  if (ALIASES[t]) return ALIASES[t];

  // existing category?
  for (const [id, c] of Object.entries(CATEGORIES)) {
    if (slug(c.label) === slug(t) || id === slug(t)) return id;
  }

  // city?
  const city = CITIES.find(c => slug(c) === slug(t) || slug(t) === slug(c + ' news'));
  if (city) return `city:${slug(city)}`;

  // fall through: a genuinely new custom topic
  return `custom:${slug(t)}`;
}

/* ---------------------------------------------------------------------------
   4. VALIDATION — run this BEFORE the first batch
   Every RSS URL below must be verified live. Dead feeds fail silently and
   starve a category — exactly the bug we're fixing. Fail the seed if a feed
   404s, don't discover it in production.
   ------------------------------------------------------------------------ */
async function validateSeed() {
  const results = [];
  for (const [id, c] of Object.entries(CATEGORIES)) {
    for (const url of (c.rss || [])) {
      try {
        const r = await fetch(url, { method: 'GET', timeout: 8000 });
        results.push({ category: id, url, ok: r.ok, status: r.status });
      } catch (e) {
        results.push({ category: id, url, ok: false, error: e.message });
      }
    }
  }
  const dead = results.filter(r => !r.ok);
  if (dead.length) {
    console.error('DEAD FEEDS — fix before seeding:', dead);
  }
  // Also assert every category has >= 1 working feed OR >= 3 queries
  for (const [id, c] of Object.entries(CATEGORIES)) {
    const live = results.filter(r => r.category === id && r.ok).length;
    if (live === 0 && (c.queries || []).length < 3) {
      console.error(`Category "${id}" has no working feeds and too few queries — will starve.`);
    }
  }
  return results;
}

module.exports = {
  CATEGORIES, TEAM_LEAGUES, CITIES, FOLLOW_SEEDS,
  teamTopic, cityTopic, followTopic,
  normalizeTopic, slug, validateSeed,
};
