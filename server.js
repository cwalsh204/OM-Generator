require("dotenv").config();
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const https = require("https");
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { Client: MCPClient } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const path = require("path");
const { Redis } = require('@upstash/redis');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

// A.CRE Intelligence Hub data is fetched via Claude MCP
// No separate API key needed — accessed through ANTHROPIC_API_KEY account connection

// ─── UPSTASH REDIS CLIENT (persistent cache across serverless instances) ───────
let redis = null;
try {
  const redisUrl   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.KV_REST_API_TOKEN  || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    redis = new Redis({ url: redisUrl, token: redisToken });
    console.log('Upstash Redis client initialised');
  } else {
    console.log('Upstash env vars not set — Redis cache disabled');
  }
} catch (e) {
  console.warn('Redis init failed — cache disabled:', e.message);
}

// ─── CACHE KEY NORMALISATION (city|state, lowercased and trimmed) ─────────────
function normaliseCacheKey(city, state, zip) {
  const stateMap = {
    'alabama':'al','alaska':'ak','arizona':'az','arkansas':'ar','california':'ca',
    'colorado':'co','connecticut':'ct','delaware':'de','florida':'fl','georgia':'ga',
    'hawaii':'hi','idaho':'id','illinois':'il','indiana':'in','iowa':'ia',
    'kansas':'ks','kentucky':'ky','louisiana':'la','maine':'me','maryland':'md',
    'massachusetts':'ma','michigan':'mi','minnesota':'mn','mississippi':'ms','missouri':'mo',
    'montana':'mt','nebraska':'ne','nevada':'nv','new hampshire':'nh','new jersey':'nj',
    'new mexico':'nm','new york':'ny','north carolina':'nc','north dakota':'nd','ohio':'oh',
    'oklahoma':'ok','oregon':'or','pennsylvania':'pa','rhode island':'ri','south carolina':'sc',
    'south dakota':'sd','tennessee':'tn','texas':'tx','utah':'ut','vermont':'vt',
    'virginia':'va','washington':'wa','west virginia':'wv','wisconsin':'wi','wyoming':'wy',
    'district of columbia':'dc','washington dc':'dc','washington d.c.':'dc'
  };
  const c = (city  || '').toLowerCase().trim().replace(/\s+/g,' ');
  const s = (state || '').toLowerCase().trim().replace(/\./g,'');
  const z = (zip   || '').trim();
  const sNorm = stateMap[s] || s;
  return z ? `acre:${c}|${sNorm}|${z}` : `acre:${c}|${sNorm}`;
}

// ─── A.CRE DATA CACHE — fallback in-memory for local dev without Redis ────────
let acreMemCache = {};

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    acreCacheEntries: Object.keys(acreMemCache).length,
    redisConnected: !!redis,
    node: process.version
  });
});

// ─── ANTHROPIC API CALL ───────────────────────────────────────────────────────
function anthropicCall(payload, includeWebSearch = false, betaHeader = null) {
  return new Promise((resolve, reject) => {
    if (includeWebSearch) {
      payload.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    };
    if (includeWebSearch) {
      headers["anthropic-beta"] = "web-search-2025-03-05";
    }
    if (betaHeader) {
      headers["anthropic-beta"] = betaHeader;
    }
    const options = { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(300000, () => { req.destroy(new Error("Request timed out after 300s")); });
    req.write(body);
    req.end();
  });
}

// ─── STEP 1: FETCH A.CRE DATA VIA MCP SDK (StreamableHTTP) ──────────────────
async function fetchAcreData(address, city, state, county, msa, zip) {
  console.log(`Fetching A.CRE data via MCP SDK for: ${address}, ${city}, ${state}${zip ? ` ${zip}` : ''}`);

  const cacheKey = normaliseCacheKey(city, state, zip);
  const today = new Date().toDateString();

  // ── Try Redis first, fall back to in-memory, fall back to live fetch ──
  try {
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`Redis cache hit for ${cacheKey}`);
        return cached;
      }
      console.log(`Redis cache miss for ${cacheKey} — fetching live`);
    } else if (acreMemCache[cacheKey] && acreMemCache[cacheKey].date === today) {
      console.log(`In-memory cache hit for ${cacheKey}`);
      return acreMemCache[cacheKey].data;
    }
  } catch (cacheErr) {
    console.warn('Redis read failed — proceeding without cache:', cacheErr.message);
  }

  const acreMcpUrl = process.env.ACRE_MCP_URL;
  if (!acreMcpUrl) {
    console.log('ACRE_MCP_URL not set — skipping A.CRE fetch');
    return null;
  }

  let mcp;
  try {
    // ── Connect directly via StreamableHTTPClientTransport (sends correct Accept header) ──
    const transport = new StreamableHTTPClientTransport(new URL(acreMcpUrl));
    mcp = new MCPClient({ name: 'om-generator', version: '1.0.0' });
    await mcp.connect(transport);
    console.log('A.CRE MCP SDK connected');

    // ── List tools and convert to Anthropic format ──
    const { tools: mcpTools } = await mcp.listTools();
    console.log(`A.CRE tools available: ${mcpTools.map(t => t.name).join(', ')}`);

    const anthropicTools = mcpTools.map(t => ({
      name:         t.name,
      description:  t.description,
      input_schema: t.inputSchema
    }));

    // ── Initial prompt: tell Claude which tools to call and what JSON to return ──
    const systemPrompt = `You are a data retrieval agent. Call the A.CRE tools to fetch data for the given property, then return a JSON summary. Call ALL relevant tools before responding.`;

    const userPrompt = `Fetch A.CRE Intelligence Hub data for: ${address}, ${city}, ${state}${zip ? ` ${zip}` : ''}${county ? ` (County: ${county}` : ''}${msa ? `, MSA: ${msa}` : ''}${county || msa ? ')' : ''}.

Call these tools in order:
1. Rates — Treasury yields, SOFR, Freddie Mac agency rates, agency MF delinquency rate
2. Census/demographics — for address: ${address}, ${city}, ${state}${zip ? ` ${zip}` : ''}
3. Employment — QCEW data for this area${zip ? `; also include ZIP-code-level employment data for ZIP ${zip} if available (unemployment rate, job mix, growth trend)` : ''}
4. Residential permits — for this county
5. Economic indicators — FRED macro data, recession signals, CPI (headline + core + shelter), construction cost YoY, CRE lending YoY
6. Rate sheet — Freddie Mac agency rate sheet: term × LTV grid with indicative rates, spreads, sample loan counts, confidence levels

After ALL tool calls, return ONLY a JSON object — no preamble, no markdown:
{
  "rates": { "treasury_10y": number, "treasury_5y": number, "sofr": number, "freddieMFRate": number, "agencySpread": number, "delinquencyRate": number, "termLTVBucket": string, "rateSheetSummary": string },
  "census": { "medianIncome": number, "population": number, "educationRate": number, "educationPercentile": number, "medianAge": number, "households": number, "populationGrowth": number, "populationGrowthPercentile": number, "incomePercentileRank": number, "renterPct": number, "ring3": { "pop": number, "households": number, "medianIncome": number, "renterPct": number }, "ring5": { "pop": number, "households": number, "medianIncome": number, "renterPct": number } },
  "employment": { "totalJobs": number, "yoyGrowth": number, "yoyGrowthPercentile": number, "avgWage": number, "avgWagePercentile": number, "topSectors": [{ "name": string, "employees": number }], "multifamilyDemandIndex": number, "zipUnemploymentRate": number|null, "msaUnemploymentRate": number|null, "momentumScore": number|null, "resilienceIndex": number|null, "empCAGR5y": number|null, "empCAGR10y": number|null, "covidRecoveryMonths": number|null, "trendDirection": string|null },
  "permits": { "ytd": number, "priorYear": number, "supplyPressureIndex": number, "permitPercentileRank": number, "trend": string, "annualData": [{ "year": number, "units": number }] },
  "economicIndicators": { "macroEnvironment": string, "macroHeadline": string, "macroNarrative": string, "recessionSignalsTriggered": number, "creditConditionsLabel": string, "creditConditionsPercentile": number, "coreInflation": number, "coreInflationPercentile": number, "consumerConfidence": number, "consumerConfidencePercentile": number, "cpiYoY": number, "shelterInflation": number, "constructionCostYoY": number, "creLendingYoY": number },
  "rateSheet": { "rateSheetNarrative": string, "termLTVNarrative": string, "rows": [{ "term": string, "ltvBucket": string, "rateRangeLow": number, "rateRangeHigh": number, "spreadBps": number, "sampleLoans": number, "confidence": "high|medium|low" }] }
}`;

    const messages = [{ role: 'user', content: userPrompt }];

    // ── Tool-use loop: run until Claude stops calling tools ──
    let finalText = '';
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;
      const response = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system:     systemPrompt,
        tools:      anthropicTools,
        messages
      });

      console.log(`A.CRE tool loop iteration ${iterations}: stop_reason=${response.stop_reason}`);

      // Collect any text from this turn
      const textContent = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (textContent) finalText = textContent;

      if (response.stop_reason !== 'tool_use') break;

      // ── Execute each tool_use block via MCP SDK ──
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const block of toolUseBlocks) {
        console.log(`Calling A.CRE tool: ${block.name}`, JSON.stringify(block.input));
        try {
          const result = await mcp.callTool({ name: block.name, arguments: block.input });
          const resultText = Array.isArray(result.content)
            ? result.content.map(c => c.text || JSON.stringify(c)).join('\n')
            : JSON.stringify(result);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
        } catch (toolErr) {
          console.warn(`Tool ${block.name} failed:`, toolErr.message);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${toolErr.message}`, is_error: true });
        }
      }

      // Append assistant turn + tool results to messages and loop
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user',      content: toolResults });
    }

    // ── Extract JSON from final text ──
    const jsonMatch = finalText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      console.log('A.CRE data fetched successfully via MCP SDK');
      console.log('Macro environment:', data.economicIndicators?.macroEnvironment);
      // ── Write to Redis (24hr TTL) or fall back to in-memory ──
      try {
        if (redis) {
          await redis.set(cacheKey, data, { ex: 86400 });
          console.log(`Redis cache written for ${cacheKey} (24hr TTL)`);
        } else {
          acreMemCache[cacheKey] = { data, date: today };
        }
      } catch (writeErr) {
        console.warn('Redis write failed — data not cached:', writeErr.message);
        acreMemCache[cacheKey] = { data, date: today };
      }
      return data;
    }

    console.log('A.CRE MCP SDK returned no parseable JSON. Final text:', finalText.slice(0, 300));
    return null;

  } catch (err) {
    console.log('A.CRE MCP SDK fetch failed:', err.message);
    return null;
  } finally {
    if (mcp) { try { await mcp.close(); } catch (_) {} }
  }
}

// ─── GEO MATH HELPERS ─────────────────────────────────────────────────────────
function calcBearing(lat1, lng1, lat2, lng2) {
  const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180;
  const Δλ = (lng2-lng1)*Math.PI/180;
  const y = Math.sin(Δλ)*Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (Math.atan2(y,x)*180/Math.PI+360)%360; // degrees from North, clockwise
}
function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // miles
  const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180;
  const Δφ = (lat2-lat1)*Math.PI/180, Δλ = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── GEOCODE MAP DOTS (Google Geocoding + Places Text Search) ─────────────────
async function geocodeMapDots(address, city, state, destinations) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !destinations.length) return null;
  try {
    // Step 1: geocode the property center (address already includes ZIP if provided)
    const geoResp = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
    );
    const geoData = await geoResp.json();
    if (geoData.status !== 'OK' || !geoData.results.length) {
      console.warn('Property geocoding failed:', geoData.status); return null;
    }
    const center = geoData.results[0].geometry.location;
    console.log(`Property geocoded: ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`);

    // Step 2: Places Text Search for each destination (parallel)
    const results = await Promise.all(destinations.slice(0,8).map(async dest => {
      try {
        const r = await fetch(
          `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(`${dest.name} ${city} ${state}`)}&location=${center.lat},${center.lng}&radius=25000&key=${apiKey}`
        );
        const d = await r.json();
        if (d.status !== 'OK' || !d.results.length) return null;
        const loc = d.results[0].geometry.location;
        const bearing  = calcBearing(center.lat, center.lng, loc.lat, loc.lng);
        const distMi   = calcDistance(center.lat, center.lng, loc.lat, loc.lng);
        console.log(`  Geocoded "${dest.name}": ${distMi.toFixed(2)} mi, ${bearing.toFixed(0)}°`);
        return { name: dest.name, category: dest.category, angleDeg: Math.round(bearing*10)/10, distanceMiles: Math.round(distMi*10)/10 };
      } catch(e) { console.warn(`Places lookup failed for ${dest.name}:`, e.message); return null; }
    }));

    const dots = results.filter(Boolean);
    console.log(`Geocoded ${dots.length}/${destinations.length} map destinations`);
    return { dots };
  } catch(e) {
    console.warn('geocodeMapDots failed:', e.message); return null;
  }
}

// ─── COUNTY INFERENCE ─────────────────────────────────────────────────────────
function inferCountyAndMSA(inputs) {
  const city = (inputs.city || "").toLowerCase();
  const state = (inputs.state || "").toLowerCase();
  const address = (inputs.address || "").toLowerCase();

  // Common city → county mappings for major CRE markets
  const countyMap = {
    "bethesda": "Montgomery County", "rockville": "Montgomery County",
    "silver spring": "Montgomery County", "chevy chase": "Montgomery County",
    "washington": "District of Columbia", "dc": "District of Columbia",
    "arlington": "Arlington County", "mclean": "Fairfax County",
    "tysons": "Fairfax County", "alexandria": "City of Alexandria",
    "new york": "New York County", "brooklyn": "Kings County",
    "manhattan": "New York County", "bronx": "Bronx County",
    "chicago": "Cook County", "los angeles": "Los Angeles County",
    "houston": "Harris County", "phoenix": "Maricopa County",
    "philadelphia": "Philadelphia County", "san antonio": "Bexar County",
    "san diego": "San Diego County", "dallas": "Dallas County",
    "austin": "Travis County", "jacksonville": "Duval County",
    "seattle": "King County", "denver": "Denver County",
    "boston": "Suffolk County", "nashville": "Davidson County",
    "miami": "Miami-Dade County", "atlanta": "Fulton County",
    "charlotte": "Mecklenburg County", "portland": "Multnomah County",
    "las vegas": "Clark County", "minneapolis": "Hennepin County",
    "tampa": "Hillsborough County", "orlando": "Orange County",
    "raleigh": "Wake County", "richmond": "City of Richmond",
    "baltimore": "Baltimore City", "annapolis": "Anne Arundel County"
  };

  const msaMap = {
    "bethesda": "Washington-Arlington-Alexandria DC-VA-MD-WV MSA",
    "rockville": "Washington-Arlington-Alexandria DC-VA-MD-WV MSA",
    "washington": "Washington-Arlington-Alexandria DC-VA-MD-WV MSA",
    "arlington": "Washington-Arlington-Alexandria DC-VA-MD-WV MSA",
    "new york": "New York-Newark-Jersey City NY-NJ-PA MSA",
    "brooklyn": "New York-Newark-Jersey City NY-NJ-PA MSA",
    "chicago": "Chicago-Naperville-Elgin IL-IN-WI MSA",
    "los angeles": "Los Angeles-Long Beach-Anaheim CA MSA",
    "miami": "Miami-Fort Lauderdale-Pompano Beach FL MSA",
    "boston": "Boston-Cambridge-Newton MA-NH MSA",
    "seattle": "Seattle-Tacoma-Bellevue WA MSA",
    "denver": "Denver-Aurora-Lakewood CO MSA",
    "dallas": "Dallas-Fort Worth-Arlington TX MSA",
    "austin": "Austin-Round Rock-Georgetown TX MSA",
    "atlanta": "Atlanta-Sandy Springs-Alpharetta GA MSA"
  };

  let county = null;
  let msa = null;

  for (const [key, val] of Object.entries(countyMap)) {
    if (city.includes(key) || address.includes(key)) {
      county = val;
      break;
    }
  }

  for (const [key, val] of Object.entries(msaMap)) {
    if (city.includes(key) || address.includes(key)) {
      msa = val;
      break;
    }
  }

  // Fallback: use city + state
  if (!county) county = `${inputs.city} County Area, ${inputs.state}`;
  if (!msa) msa = `${inputs.city}, ${inputs.state} Metro Area`;

  return { county, msa };
}

// ─── STEP 2: WEB SEARCH FALLBACKS ─────────────────────────────────────────────
async function fetchWebFallbacks(inputs, acreData) {
  const failedSources = Object.entries(acreData.sources || {})
    .filter(([, v]) => v === "fallback_needed")
    .map(([k]) => k);

  // Always search for market narrative and rent comps regardless of A.CRE
  const alwaysSearch = []; // TEMP: restore to ["marketNarrative","rentComps","legislation"] when ACRE resets
  const toSearch = [...new Set([...failedSources, ...alwaysSearch])];

  const searchQueries = {
    rates: `10Y Treasury yield today FRED site:fred.stlouisfed.org OR site:treasury.gov`,
    census: `${inputs.city} ${inputs.state} census demographics median household income ACS 2024`,
    employment: `${inputs.city} ${inputs.state} employment jobs BLS QCEW 2025 2026`,
    permits: `${inputs.market || inputs.city} multifamily residential permits supply pipeline 2025 2026`,
    rateSheet: `Freddie Mac multifamily indicative rates spreads K-Deal 2026`,
    marketNarrative: `${inputs.market || inputs.city} ${inputs.assetType || "multifamily"} market report vacancy rents 2025 2026 CBRE OR JLL OR "Cushman & Wakefield"`,
    rentComps: `${inputs.market || inputs.city} ${inputs.assetType || "multifamily"} rent comparables average rent per unit 2025 2026`,
    legislation: `${inputs.state} landlord tenant rent control legislation 2025 2026`
  };

  // Determine if A.CRE returned live rate data (flat structure from MCP)
  const _rn = (v) => { const n = parseFloat(v); return (!isNaN(n) && n > 0 && n < 30) ? n : null; };
  const acreHasRates = !!(_rn(acreData.rates?.treasury_10y));

  // Rate-specific web search queries — always run when A.CRE rates are absent
  const rateSearchLines = !acreHasRates ? [
    `Search for: "10 year Treasury yield today FRED"`,
    `Search for: "5 year Treasury yield today FRED"`,
    `Search for: "SOFR rate today New York Fed"`,
    `Search for: "Freddie Mac multifamily loan rate today"`
  ] : [];

  if (toSearch.length === 0 && rateSearchLines.length === 0) {
    console.log("No web fallbacks needed");
    return { raw: "", searched: [], webRates: null };
  }

  console.log(`Running web search for: ${toSearch.join(", ")}${!acreHasRates ? " + rate queries (A.CRE rates unavailable)" : ""}`);

  const generalSearchPrompt = toSearch
    .map(key => searchQueries[key] ? `Search for: "${searchQueries[key]}"` : null)
    .filter(Boolean)
    .join("\n");
  const searchPrompt = [generalSearchPrompt, ...rateSearchLines].filter(Boolean).join("\n");

  const webSearchPrompt = `You are a CRE research analyst. Search the web and extract data for this property. Return ONLY compact JSON — no prose, no explanation. Use null for any field you cannot find. Never fabricate data.

PROPERTY: ${inputs.propertyName || 'Subject Property'}
ADDRESS: ${inputs.address}, ${inputs.city}, ${inputs.state}
COUNTY: ${acreData.county}, MSA: ${acreData.msa}

Search queries to run:
- "${inputs.city} ${inputs.state} median household income 2024 2025"
- "${inputs.city} multifamily market vacancy rent 2025 2026"
- "${acreData.county} multifamily permits supply pipeline 2025"
- "10 year treasury yield today"
- "SOFR rate today"
- "Freddie Mac multifamily rates 2026"
- "${inputs.city} ${inputs.state} major employers 2025"
- "${inputs.city} Class A apartment rent comps 2025"
- "${acreData.county} rent stabilization rent control 2024 2025"
- "grocery stores restaurants retail near ${inputs.address} ${inputs.city} ${inputs.state} walking distance miles"
- "metro subway bus transit stops near ${inputs.address} ${inputs.city} distance"
- "walk score ${inputs.address} ${inputs.city} ${inputs.state}"

Return this exact JSON structure with real numbers only:
{
  "rates": {
    "treasury_10y": number|null,
    "treasury_5y": number|null,
    "sofr": number|null,
    "freddieMFRate": number|null
  },
  "demographics": {
    "medianHouseholdIncome": number|null,
    "population": number|null,
    "populationGrowthPct": number|null,
    "bachelorsDegreeRatePct": number|null,
    "medianAge": number|null,
    "renterOccupiedPct": number|null
  },
  "employment": {
    "totalJobs": number|null,
    "yoyGrowthPct": number|null,
    "unemploymentRatePct": number|null,
    "topEmployers": [{"name": string, "employees": number}],
    "topSectors": [{"name": string, "employees": number}]
  },
  "multifamilyMarket": {
    "vacancyRatePct": number|null,
    "avgAskingRentPerUnit": number|null,
    "yoyRentGrowthPct": number|null,
    "underConstructionUnits": number|null,
    "capRateRange": string|null
  },
  "rentComps": [
    {
      "propertyName": string,
      "units": number,
      "yearBuilt": number,
      "avgRentPerUnit": number,
      "occupancyPct": number
    }
  ],
  "supplyPipeline": {
    "permitsYTD": number|null,
    "permitsPriorYear": number|null,
    "unitsUnderConstruction": number|null,
    "supplyNarrative": string|null
  },
  "macroBackdrop": {
    "fedFundsRate": number|null,
    "cpiYoYPct": number|null,
    "multifamilyOutlook": string|null,
    "macroNarrative": string|null
  },
  "legislation": string|null,
  "marketNarrative": string|null,
  "locationAmenities": {
    "walkScore": number|null,
    "transitScore": number|null,
    "bikeScore": number|null,
    "nearbyRetail": [{"name": string, "type": string, "distanceMiles": number}],
    "nearbyDining": [{"name": string, "type": string, "distanceMiles": number}],
    "nearbyTransit": [{"name": string, "type": string, "distanceMiles": number}],
    "nearbyEducation": [{"name": string, "type": string, "distanceMiles": number}],
    "nearbyHealthcare": [{"name": string, "type": string, "distanceMiles": number}],
    "neighborhoodNarrative": string|null
  }
}`;

  try {
    const result = await anthropicCall({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: "user", content: webSearchPrompt }]
    }, true); // enable web search

    // Extract all text from response including after tool use
    const textBlocks = (result.body.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    console.log("Web search complete. Text length:", textBlocks.length);

    // Parse structured JSON from response
    let webData = null;
    const jsonMatch = textBlocks.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        webData = JSON.parse(jsonMatch[0]);
        console.log("Parsed web search JSON successfully");
      } catch (e) {
        console.warn("Failed to parse web search JSON:", e.message);
      }
    }

    // Extract rates from structured response (Change 4)
    let webRates = null;
    if (!acreHasRates) {
      if (webData?.rates) {
        const validNum = (v) => typeof v === "number" && v > 0 && v < 30 ? v : null;
        webRates = {
          treasury_10y:  validNum(webData.rates.treasury_10y),
          treasury_5y:   validNum(webData.rates.treasury_5y),
          sofr:          validNum(webData.rates.sofr),
          freddieMFRate: validNum(webData.rates.freddieMFRate)
        };
        console.log("Parsed web rates from JSON:", JSON.stringify(webRates));
      } else {
        // Fallback: try PARSED_RATES block in plain text
        const match = textBlocks.match(/PARSED_RATES:\s*(\{[^}]+\})/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            const validNum = (v) => typeof v === "number" && v > 0 && v < 30 ? v : null;
            webRates = {
              treasury_10y:  validNum(parsed.treasury_10y),
              treasury_5y:   validNum(parsed.treasury_5y),
              sofr:          validNum(parsed.sofr),
              freddieMFRate: validNum(parsed.freddieMFRate)
            };
            console.log("Parsed web rates from PARSED_RATES block:", JSON.stringify(webRates));
          } catch (e) {
            console.warn("Failed to parse PARSED_RATES block:", e.message);
          }
        } else {
          console.log("No rate data found in web search response");
        }
      }
    }

    return { raw: textBlocks, searched: toSearch, webRates, webData };
  } catch (err) {
    console.error("Web search failed:", err.message);
    return { raw: "", searched: [], webRates: null, webData: null };
  }
}

// ─── QCEW SECTOR FILTER ───────────────────────────────────────────────────────
// Haiku sometimes returns BLS/QCEW industry sector labels in topEmployers instead of named companies.
// These patterns detect sector names so we can filter them out and keep only real employers.
function isQcewSector(name) {
  if (!name) return true;
  const n = name.trim();
  // Known QCEW super-sector and sector names (BLS industry classification labels)
  const exactSectors = new Set([
    'Manufacturing','Construction','Utilities','Information','Government',
    'Agriculture','Mining','Transportation','Warehousing','Scientific',
    'Administrative','Accommodation','Entertainment','Professional',
    'Finance','Insurance','Healthcare','Education','Retail','Wholesale',
    'Retail Trade','Wholesale Trade','Real Estate','Public Administration',
    'Other Services','Food Services'
  ]);
  if (exactSectors.has(n)) return true;
  // Pattern: contains " and " connecting two industry terms (e.g., "Health Care and Social Assistance")
  if (/\b(health care|social assistance|waste management|rental.?leasing|oil.?gas|fishing.?hunting)\b/i.test(n)) return true;
  // Pattern: ends with "Services" but isn't a company name (company names don't start with a generic category)
  if (/^(professional|technical|business|financial|management|administrative|educational|food|other|public|government)\b.{0,40}services?$/i.test(n)) return true;
  // Pattern: starts with a known sector word and is all generic (no proper-noun company identifiers)
  if (/^(health care|professional.*(scientific|technical)|transportation.*(warehousing)?|arts.*entertainment|accommodation.*food)/i.test(n)) return true;
  return false;
}

// ─── STEP 2b: SONNET GAP-FILL ─────────────────────────────────────────────────
async function fillDataGaps(haikusData, address, city, state, county) {
  const missingFields = [];
  if (!haikusData?.rentComps?.length) missingFields.push('rent comps for ' + city + ' Class A multifamily 2025 2026');
  // Trigger gap-fill if topEmployers is empty OR if all entries look like QCEW sector labels
  const _hasRealEmployers = (haikusData?.employment?.topEmployers || []).some(e => !isQcewSector(e.name));
  if (!_hasRealEmployers) missingFields.push('top named employers in ' + city + ' ' + state + ' with employee headcounts 2025 — list specific named companies and organizations only, not industry sectors');
  if (!haikusData?.multifamilyMarket?.vacancyRatePct) missingFields.push(city + ' multifamily vacancy rate 2025 2026 CBRE JLL');
  if (!haikusData?.demographics?.medianHouseholdIncome) missingFields.push(city + ' ' + state + ' median household income census 2024');
  if (!haikusData?.macroBackdrop?.macroNarrative) missingFields.push('multifamily market outlook 2026 Freddie Mac Fannie Mae');
  if (!haikusData?.locationAmenities?.nearbyRetail?.length) missingFields.push(`walking distance to retail grocery restaurants transit from ${address} ${city} ${state} — return specific place names and distances in miles from this exact address`);

  if (missingFields.length === 0) {
    console.log('Haiku web search complete — no gaps to fill');
    return haikusData;
  }

  console.log(`Running Sonnet gap-fill for ${missingFields.length} missing fields...`);

  const gapFillPayload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Search the web for the following missing CRE market data. Return ONLY JSON with these exact fields filled in. Use null if still not found. Never fabricate.

Missing data needed:
${missingFields.map((f, i) => `${i+1}. Search: "${f}"`).join('\n')}

Return JSON with only these fields:
{
  "rentComps": [{"propertyName": string, "units": number, "yearBuilt": number, "avgRentPerUnit": number, "occupancyPct": number}],
  "topEmployers": [{"name": string, "employees": number, "sector": string}],
  "vacancyRatePct": number|null,
  "medianHouseholdIncome": number|null,
  "macroNarrative": string|null,
  "locationAmenities": {
    "walkScore": number|null,
    "transitScore": number|null,
    "bikeScore": number|null,
    "nearbyRetail": [{"name": string, "type": string, "distanceMiles": number}],
    "nearbyDining": [{"name": string, "type": string, "distanceMiles": number}],
    "nearbyTransit": [{"name": string, "type": string, "distanceMiles": number}],
    "nearbyEducation": [{"name": string, "type": string, "distanceMiles": number}],
    "nearbyHealthcare": [{"name": string, "type": string, "distanceMiles": number}],
    "neighborhoodNarrative": string|null
  }
}`
    }]
  };

  try {
    const gapResult = await anthropicCall(gapFillPayload, true);
    if (gapResult.status === 200) {
      const gapText = (gapResult.body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const jsonMatch = gapText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const gapData = JSON.parse(jsonMatch[0]);
        console.log('Sonnet gap-fill complete');
        if (gapData.rentComps?.length) haikusData.rentComps = gapData.rentComps;
        if (gapData.topEmployers?.length) { haikusData.employment = haikusData.employment || {}; haikusData.employment.topEmployers = gapData.topEmployers; }
        if (gapData.vacancyRatePct) { haikusData.multifamilyMarket = haikusData.multifamilyMarket || {}; haikusData.multifamilyMarket.vacancyRatePct = gapData.vacancyRatePct; }
        if (gapData.medianHouseholdIncome) { haikusData.demographics = haikusData.demographics || {}; haikusData.demographics.medianHouseholdIncome = gapData.medianHouseholdIncome; }
        if (gapData.macroNarrative) { haikusData.macroBackdrop = haikusData.macroBackdrop || {}; haikusData.macroBackdrop.macroNarrative = gapData.macroNarrative; }
        if (gapData.locationAmenities) haikusData.locationAmenities = gapData.locationAmenities;
      }
    }
  } catch(err) {
    console.log('Sonnet gap-fill failed:', err.message);
  }

  return haikusData;
}

// ─── STEP 3: SUMMARIZE ALL DATA FOR PROMPT ────────────────────────────────────
function buildDataContext(acreData, webFallbacks, inputs) {
  const lines = [];
  const { county, msa } = acreData;

  lines.push(`INFERRED LOCATION: County: ${county}, MSA: ${msa}`);

  // A.CRE Rates (flat structure from MCP)
  if (acreData.rates && acreData.sources?.rates !== "fallback_needed") {
    const { treasury_10y: t10, treasury_5y: t5, sofr, agencySpread, delinquencyRate, termLTVBucket } = acreData.rates;
    if (t10) lines.push(`RATES [A.CRE LIVE]: 10Y Treasury: ${t10}%, 5Y: ${t5 || "N/A"}%, SOFR: ${sofr || "N/A"}%, Agency Spread: ${agencySpread || "N/A"}bps, MF Delinquency: ${delinquencyRate || "N/A"}%`);
  }

  // A.CRE Rate Sheet narrative
  if (acreData.rateSheet) {
    const rs = acreData.rateSheet;
    if (rs.rateSheetNarrative) lines.push(`AGENCY RATE SHEET [A.CRE LIVE]: ${rs.rateSheetNarrative}`);
    if (rs.termLTVNarrative) lines.push(`TERM/LTV BUCKET [A.CRE LIVE]: ${rs.termLTVNarrative}`);
  }

  // A.CRE Census (flat structure from MCP)
  if (acreData.census) {
    const c = acreData.census;
    if (c.medianIncome) lines.push(`DEMOGRAPHICS [A.CRE/ACS]: Median HH Income: $${Number(c.medianIncome).toLocaleString()} (${c.incomePercentileRank || "N/A"}th national percentile), Population: ${Number(c.population || 0).toLocaleString()}, College-educated: ${c.educationRate || "N/A"}%, Median Age: ${c.medianAge || "N/A"}, Households: ${Number(c.households || 0).toLocaleString()}, Pop. Growth since 2020: ${c.populationGrowth || "N/A"}%`);
  }

  // A.CRE Employment (flat structure from MCP)
  if (acreData.employment) {
    const e = acreData.employment;
    const sectors = (e.topSectors || []).slice(0, 4).map(s => `${s.name} (${Number(s.employees || 0).toLocaleString()} jobs, median $${Number(s.medianEarnings || 0).toLocaleString()})`).join(", ");
    if (e.totalJobs) lines.push(`EMPLOYMENT [A.CRE/BLS-QCEW]: Total Jobs: ${Number(e.totalJobs).toLocaleString()}, YoY Growth: ${e.yoyGrowth || "N/A"}%, Multifamily Demand Index: ${e.multifamilyDemandIndex || "N/A"}/100, Top sectors: ${sectors || "N/A"}${e.zipUnemploymentRate != null ? `, ZIP Unemployment: ${e.zipUnemploymentRate}%` : ''}${e.msaUnemploymentRate != null ? `, MSA Unemployment: ${e.msaUnemploymentRate}%` : ''}${e.trendDirection ? `, Trend: ${e.trendDirection}` : ''}${e.empCAGR5y != null ? `, 5yr CAGR: ${e.empCAGR5y}%` : ''}${e.momentumScore != null ? `, Momentum Score: ${e.momentumScore}` : ''}`);
  }

  // A.CRE Permits (flat structure from MCP)
  if (acreData.permits) {
    const p = acreData.permits;
    if (p.supplyPressureIndex !== undefined) lines.push(`SUPPLY PRESSURE [A.CRE/Census]: Supply Pressure Index: ${p.supplyPressureIndex}/100 (${p.permitPercentileRank || "N/A"}th national percentile), YTD Permits: ${Number(p.ytd || 0).toLocaleString()} units, Prior Year: ${Number(p.priorYear || 0).toLocaleString()} units, Trend: ${p.trend || "N/A"}`);
  }

  // A.CRE Economic Indicators (new from MCP)
  if (acreData.economicIndicators) {
    const ei = acreData.economicIndicators;
    lines.push(`\nMACRO ECONOMIC ENVIRONMENT (A.CRE):\n- Overall Assessment: ${(ei.macroEnvironment || "").toUpperCase()}\n- Macro Headline: ${ei.macroHeadline || "N/A"}\n- Recession Signals Triggered: ${ei.recessionSignalsTriggered ? "YES — FLAG IN RISKS SECTION" : "No"}\n- Macro Narrative: ${ei.macroNarrative || "N/A"}\n- Top FRED Series: ${(ei.topFredSeries || []).map(s => `${s.name}: ${s.value} (${s.yoyPct > 0 ? "+" : ""}${s.yoyPct}% YoY, ${s.trend})`).join(", ")}`);
  }

  // Web Search Structured Data
  if (webFallbacks.webData) {
    const webData = webFallbacks.webData;

    if (webData.demographics) {
      const d = webData.demographics;
      lines.push(`\nDEMOGRAPHICS (${d.source || 'Web Search'}):\n- Median Household Income: $${d.medianHouseholdIncome?.toLocaleString()}\n- Population: ${d.population?.toLocaleString()} (${d.populationGrowthPct}% growth)\n- Bachelor's Degree Rate: ${d.bachelorsDegreeRatePct}%\n- Median Age: ${d.medianAge}\n- Renter Occupied: ${d.renterOccupiedPct}%`);
    }

    if (webData.employment) {
      const e = webData.employment;
      lines.push(`\nEMPLOYMENT (${e.source || 'Web Search'}):\n- Total Jobs: ${e.totalJobs?.toLocaleString()}\n- YoY Growth: ${e.yoyGrowthPct}%\n- Unemployment Rate: ${e.unemploymentRatePct}%\n- Top Employers: ${e.topEmployers?.map(emp => `${emp.name} (${emp.employees?.toLocaleString()} employees)`).join(', ')}\n- Top Sectors: ${e.topSectors?.map(s => `${s.name}: ${s.employees?.toLocaleString()} jobs, $${s.medianEarnings?.toLocaleString()} median earnings`).join('; ')}\n- Narrative: ${e.majorEmployersNarrative}`);
    }

    if (webData.multifamilyMarket) {
      const m = webData.multifamilyMarket;
      lines.push(`\nMULTIFAMILY MARKET (${m.source || 'Web Search'}):\n- Submarket: ${m.submarket}\n- Vacancy Rate: ${m.vacancyRatePct}%\n- Avg Asking Rent: $${m.avgAskingRentPerUnit}/unit, $${m.avgAskingRentPerSF}/SF\n- YoY Rent Growth: ${m.yoyRentGrowthPct}%\n- New Supply: ${m.newSupplyUnits?.toLocaleString()} units\n- Under Construction: ${m.underConstructionUnits?.toLocaleString()} units\n- Cap Rate Range: ${m.capRateRange}\n- Trend: ${m.marketTrend}`);
    }

    if (webData.rentComps?.length > 0) {
      lines.push(`\nRENT COMPS (Web Search):`);
      webData.rentComps.forEach(comp => {
        lines.push(`- ${comp.propertyName}: ${comp.units} units, built ${comp.yearBuilt}, $${comp.avgRentPerUnit}/unit ($${comp.avgRentPerSF}/SF), ${comp.occupancyPct}% occupied, ${comp.distanceMiles} miles away`);
      });
    }

    if (webData.supplyPipeline) {
      const s = webData.supplyPipeline;
      lines.push(`\nSUPPLY PIPELINE (${s.source || 'Web Search'}):\n- Permits YTD: ${s.permitsYTD?.toLocaleString()}\n- Prior Year Permits: ${s.permitsPriorYear?.toLocaleString()}\n- Units Under Construction: ${s.unitsUnderConstruction?.toLocaleString()}\n- Deliveries Next 12 Months: ${s.deliveriesNext12Months?.toLocaleString()}\n- Narrative: ${s.supplyNarrative}`);
    }

    if (webData.locationAmenities) {
      const a = webData.locationAmenities;
      lines.push(`\nLOCATION AMENITIES (Web Search):\n- Walk Score: ${a.walkScore}, Transit Score: ${a.transitScore}, Bike Score: ${a.bikeScore}\n- Nearby Retail: ${a.nearbyRetail?.map(r => `${r.name} (${r.distanceMiles} mi)`).join(', ')}\n- Nearby Dining: ${a.nearbyDining?.map(r => `${r.name} (${r.distanceMiles} mi)`).join(', ')}\n- Nearby Transit: ${a.nearbyTransit?.map(r => `${r.name} (${r.distanceMiles} mi)`).join(', ')}\n- Nearby Healthcare: ${a.nearbyHealthcare?.map(r => `${r.name} (${r.distanceMiles} mi)`).join(', ')}\n- Nearby Education: ${a.nearbyEducation?.map(r => `${r.name} (${r.distanceMiles} mi)`).join(', ')}\n- Neighborhood: ${a.neighborhoodNarrative}`);
    }

    if (webData.macroBackdrop) {
      const mac = webData.macroBackdrop;
      lines.push(`\nMACRO BACKDROP (${mac.source || 'Web Search'}):\n- Fed Funds Rate: ${mac.fedFundsRate}%\n- CPI YoY: ${mac.cpiYoYPct}%\n- GDP Growth: ${mac.gdpGrowthPct}%\n- Multifamily Outlook: ${mac.multifamilyOutlook}\n- Recession Risk: ${mac.recessionRisk}\n- Narrative: ${mac.macroNarrative}`);
    }

    if (webData.marketNarrative) lines.push(`\nMARKET NARRATIVE (Web Search): ${webData.marketNarrative}`);
    if (webData.rentCompsNarrative) lines.push(`RENT COMPS NARRATIVE (Web Search): ${webData.rentCompsNarrative}`);
    if (webData.legislationNarrative) lines.push(`LEGISLATION (Web Search): ${webData.legislationNarrative}`);
  }

  // Web Search Raw Fallback (when JSON parse failed)
  if (webFallbacks.raw && webFallbacks.raw.length > 0 && !webFallbacks.webData) {
    lines.push(`\nWEB RESEARCH FINDINGS [${(webFallbacks.searched || []).join(", ")}]:`);
    lines.push(webFallbacks.raw.slice(0, 3000)); // cap at 3000 chars
  }

  // Data source transparency note
  const acreSources = Object.entries(acreData.sources || {}).filter(([, v]) => v.includes("acre")).map(([k]) => k);
  const webSources = Object.entries(acreData.sources || {}).filter(([, v]) => v === "fallback_needed").map(([k]) => k);
  lines.push(`\nDATA SOURCES USED: A.CRE live data: [${acreSources.join(", ")}]. Web search used for: [${webSources.join(", ")}] plus market narrative and rent comps.`);

  return lines.join("\n");
}

// ─── STEP 4: GENERATE OM JSON (NO WEB SEARCH TOOL) ───────────────────────────
async function generateOMJSON(inputs, dataContext, parsedFiles) {
  const prompt = buildPrompt(inputs, dataContext, parsedFiles);

  // NO web search tool here — Claude only synthesizes pre-fetched data into JSON
  const result = await anthropicCall({
    model: "claude-opus-4-5-20251101",
    max_tokens: 8000,
    system: `You are an institutional CRE offering memorandum writer.

You have been provided with pre-researched market data. Your job is to synthesize this data into a comprehensive, lender-focused offering memorandum.

DATA HIERARCHY:
1. A.CRE live data marked [A.CRE LIVE] — authoritative for all numerical figures. Cite these exactly.
2. Web research findings — qualitative context from CBRE, JLL, BLS, Census. Use to support narrative.
3. Deal inputs — authoritative for all property-specific figures.
4. Never invent numbers not present in any source above.

OUTPUT REQUIREMENT: Return ONLY a raw JSON object. No markdown. No backticks. No preamble. No explanation. Your ENTIRE response must be valid JSON. Start immediately with { and end with }. Any text outside the JSON braces will cause a critical error.`,
    messages: [{ role: "user", content: prompt }, { role: "assistant", content: "{" }]
  }, false); // NO web search tool

  if (result.status !== 200) {
    throw new Error(`Anthropic API returned ${result.status}: ${result.body?.error?.message || JSON.stringify(result.body).slice(0, 200)}`);
  }

  const textBlock = (result.body.content || []).find(c => c.type === "text");
  let rawText = textBlock?.text || ""; if (rawText && !rawText.trim().startsWith("{")) rawText = "{" + rawText;
  console.log("OM JSON generation complete. Preview:", rawText.slice(0, 100));

  if (!rawText || rawText.trim().length < 10) {
    throw new Error("Empty response from API");
  }

  return extractJSON(rawText);
}

// ─── MAIN GENERATE ENDPOINT ───────────────────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Replit Secrets" });

  const { inputs, parsedFiles } = req.body;
  if (!inputs) return res.status(400).json({ error: "No inputs provided" });

  console.log(`\n═══ Starting OM generation for: ${inputs.propName} ═══`);

  try {
    // Step 1: Fetch A.CRE data via Claude MCP
    console.log("Step 1: Fetching live CRE market data...");
    const { county, msa } = inferCountyAndMSA(inputs);
    const address = `${inputs.address}, ${inputs.city}, ${inputs.state}${inputs.zip ? ' ' + inputs.zip : ''}`;
    console.log(`Location: ${county}, ${msa}`);
    const mcpData = await fetchAcreData(address, inputs.city, inputs.state, county, msa, inputs.zip);
    const acreData = {
      county, msa,
      ...(mcpData || {}),
      sources: mcpData
        ? { rates: "acre_live", census: "acre_live", employment: "acre_live", permits: "acre_live", rateSheet: "acre_live" }
        : { rates: "fallback_needed", census: "fallback_needed", employment: "fallback_needed", permits: "fallback_needed", rateSheet: "fallback_needed" }
    };

    // Step 2: Web search — Haiku compact JSON
    console.log("Step 2: Running web search (Haiku)...");
    const webFallbacks = await fetchWebFallbacks(inputs, acreData);

    // Step 2b: Sonnet gap-fill for missing critical fields
    if (webFallbacks.webData) {
      webFallbacks.webData = await fillDataGaps(webFallbacks.webData, address, inputs.city, inputs.state, county);
    }

    // Step 3: Build combined data context
    console.log("Step 3: Building data context...");
    const dataContext = buildDataContext(acreData, webFallbacks, inputs);
    console.log(`Data context length: ${dataContext.length} chars`);

    // Step 4: Generate OM JSON (no web search tool — pure synthesis)
    console.log("Step 4: Generating OM...");
    const omContent = await generateOMJSON(inputs, dataContext, parsedFiles || {});

    // ── Attach walk/transit/bike scores from web search → omContent (no Stage 1 field needed) ──
    const _haikus = webFallbacks.haikusData || {};
    omContent.walkScore    = _haikus.walkScore    != null ? parseInt(_haikus.walkScore)    : null;
    omContent.transitScore = _haikus.transitScore != null ? parseInt(_haikus.transitScore) : null;
    omContent.bikeScore    = _haikus.bikeScore    != null ? parseInt(_haikus.bikeScore)    : null;

    // ── Attach major employers from web search → omContent ──
    // Prefer web-searched named companies; fall back to Claude-generated list from main prompt.
    // Filter out QCEW sector labels (e.g. "Professional Services") that Haiku sometimes returns.
    const _webEmps = webFallbacks.webData?.employment?.topEmployers;
    if (Array.isArray(_webEmps) && _webEmps.length > 0) {
      const _realEmps = _webEmps
        .filter(e => !isQcewSector(e.name))
        .slice(0, 5)
        .map(e => ({ name: e.name || null, employees: typeof e.employees === 'number' ? e.employees : null }))
        .filter(e => e.name);
      if (_realEmps.length >= 2) {
        // Web search returned real named companies — use them (overwrite Claude's guess)
        omContent.locationMajorEmployers = _realEmps;
        console.log(`Attached ${_realEmps.length} web-searched real employers to omContent`);
      } else {
        // Web search returned sector labels — keep Claude's Sonnet-generated list if available
        console.log(`Web search returned ${_webEmps.length} employer entries but ${_realEmps.length} passed sector filter — keeping Claude-generated list`);
        if (!Array.isArray(omContent.locationMajorEmployers) || !omContent.locationMajorEmployers.length) {
          omContent.locationMajorEmployers = null;
        }
      }
    } else if (!Array.isArray(omContent.locationMajorEmployers) || !omContent.locationMajorEmployers.length) {
      // No web data and Claude didn't generate it — leave null so renderer falls back gracefully
      omContent.locationMajorEmployers = null;
    }

    // ── Rate resolution: A.CRE MCP live → web search → null (frontend handles fallback) ──
    const _rateNum = (v) => { const n = parseFloat(v); return (!isNaN(n) && n > 0 && n < 30) ? n : null; };
    const acreT10    = _rateNum(acreData.rates?.treasury_10y)  || null;
    const acreT5     = _rateNum(acreData.rates?.treasury_5y)   || null;
    const acreSofr   = _rateNum(acreData.rates?.sofr)          || null;
    const wr         = webFallbacks.webRates || {};
    console.log("Mapped rates:", JSON.stringify({ acreT10, acreT5, acreSofr }));
    console.log("Web fallback rates:", JSON.stringify(wr));

    const resolvedRates = {
      treasury_10y:    acreT10   || wr.treasury_10y  || null,
      treasury_5y:     acreT5    || wr.treasury_5y   || null,
      sofr:            acreSofr  || wr.sofr           || null,
      freddieMFRate:   _rateNum(acreData.rates?.freddieMFRate) || wr.freddieMFRate || null,
      agencySpread:    acreData.rates?.agencySpread   || null,
      delinquencyRate: acreData.rates?.delinquencyRate || null,
      termLTVBucket:   acreData.rates?.termLTVBucket  || "10yr/65%"
    };

    // rateSources: "live" | "websearch" | "fallback" — used by frontend for badges
    const rateSources = {
      treasury_10y:  acreT10   ? "live" : wr.treasury_10y  ? "websearch" : "fallback",
      treasury_5y:   acreT5    ? "live" : wr.treasury_5y   ? "websearch" : "fallback",
      sofr:          acreSofr  ? "live" : wr.sofr           ? "websearch" : "fallback",
      freddieMFRate: acreData?.rates?.freddieMFRate ? "live" : wr.freddieMFRate ? "websearch" : "fallback"
    };

    console.log("Rate sources:", JSON.stringify(rateSources));

    // ── Normalize acreData flat → nested for frontend (buildDataContext has already consumed flat keys) ──
    if (acreData.census && !acreData.census.demographics) {
      const c = acreData.census;
      acreData.census = {
        demographics: {
          median_household_income:   { value: c.medianIncome || null, national_percentile: c.incomePercentileRank || null },
          total_population:          { value: c.population || null },
          bachelor_degree_or_higher: { value: c.educationRate || null, national_percentile: c.educationPercentile || null },
          population_growth:         { value: c.populationGrowth || null, national_percentile: c.populationGrowthPercentile || null },
          owner_occupied:            { value: c.ownerOccupied || null }
        }
      };
    }
    if (acreData.employment && !acreData.employment.qcew) {
      const e = acreData.employment;
      acreData.employment = {
        laus: { unemployment_rate: e.unemploymentRate || null },
        qcew: {
          top_sectors: (e.topSectors || []).map(s => ({
            sector_name:      s.name,
            employment_count: s.employees
          })),
          avg_wage:            e.avgWage             || null,
          avg_wage_percentile: e.avgWagePercentile   || null,
          total_employment:    e.totalEmployment     || e.totalJobs || null
        },
        yoy_growth:            e.yoyGrowth           || null,
        yoy_growth_percentile: e.yoyGrowthPercentile || null,
        history:               e.history             || null,
        property_demand_index: {
          multifamily: (() => {
            // A.CRE returns 0–1 scale; renderer expects 0–100
            const raw = e.multifamilyDemandIndex || null;
            const score = raw != null ? (raw <= 1 ? Math.round(raw * 100) : Math.round(raw)) : null;
            return { score, label: score != null ? String(score) : null };
          })()
        },
        // ZIP-level and extended fields
        zipUnemploymentRate: e.zipUnemploymentRate  ?? null,
        msaUnemploymentRate: e.msaUnemploymentRate  ?? null,
        momentumScore:       e.momentumScore        ?? null,
        resilienceIndex:     e.resilienceIndex      ?? null,
        empCAGR5y:           e.empCAGR5y            ?? null,
        empCAGR10y:          e.empCAGR10y           ?? null,
        covidRecoveryMonths: e.covidRecoveryMonths  ?? null,
        trendDirection:      e.trendDirection       ?? null
      };
    }
    if (acreData.permits && acreData.permits.supplyPressureIndex !== undefined && !acreData.permits.supply_pressure_index) {
      const p = acreData.permits;
      acreData.permits = {
        supply_pressure_index: { current_score: p.supplyPressureIndex, label: null, national_percentile: p.permitPercentileRank || null },
        trailing_12_months:    { total_units: p.ytd || null },
        ytd_2025:              p.ytd || null,
        permit_trend:          { annual_data: p.annualData || null }
      };
    }

    // ── Normalize economicIndicators.macroEnvironment → exact keyword ──
    if (acreData.economicIndicators?.macroEnvironment) {
      const raw = acreData.economicIndicators.macroEnvironment.toLowerCase();
      if (raw === 'favorable' || raw === 'cautious' || raw === 'neutral') { /* already correct */ }
      else if (
        raw.includes('cautious') || raw.includes('warning') || raw.includes('tighten') ||
        raw.includes('declining') || raw.includes('headwind') || raw.includes('mixed') ||
        raw.includes('accelerat') || raw.includes('elevated') || raw.includes('recession') ||
        raw.includes('deteriorat') || raw.includes('pressure')
      ) {
        acreData.economicIndicators.macroEnvironment = 'cautious';
      } else if (
        raw.includes('favorable') || raw.includes('expanding') || raw.includes('positive') ||
        raw.includes('strong') || raw.includes('robust') || raw.includes('improving')
      ) {
        acreData.economicIndicators.macroEnvironment = 'favorable';
      } else {
        acreData.economicIndicators.macroEnvironment = 'neutral';
      }
      console.log('Normalized macroEnvironment →', acreData.economicIndicators.macroEnvironment);
    }

    // Forward web-sourced vacancy rate into market object for renderer
    const _webVacancy = webFallbacks.webData?.multifamilyMarket?.vacancyRatePct
      ?? webFallbacks.haikusData?.multifamilyMarket?.vacancyRatePct
      ?? null;

    // ── Geocode map dots for accurate location map ────────────────────────────
    const _mapDestinations = [
      ...(Array.isArray(omContent.locationRetail)        ? omContent.locationRetail.slice(0,3).map(d=>({name:d.name,category:'retail'}))   : []),
      ...(Array.isArray(omContent.locationMajorEmployers)? omContent.locationMajorEmployers.slice(0,3).map(d=>({name:d.name,category:'employer'})) : []),
      ...(Array.isArray(omContent.locationTransit)       ? omContent.locationTransit.slice(0,2).map(d=>({name:d.name,category:'transit'}))  : []),
      ...(Array.isArray(omContent.locationEducation)     ? omContent.locationEducation.slice(0,2).map(d=>({name:d.name,category:'education'})): []),
    ].filter(d => d.name);

    const _mapCacheKey = `mapDots:${(inputs.address||'').toLowerCase().trim()}|${(inputs.city||'').toLowerCase().trim()}|${(inputs.state||'').toLowerCase().trim()}`;
    let _mapDots = null;
    try {
      if (redis) { _mapDots = await redis.get(_mapCacheKey); if (_mapDots) console.log('Map dots: Redis cache hit'); }
    } catch(e) { console.warn('Map dots cache read failed:', e.message); }

    if (!_mapDots && _mapDestinations.length > 0) {
      _mapDots = await geocodeMapDots(inputs.address, inputs.city, inputs.state, _mapDestinations);
      if (_mapDots) {
        try {
          if (redis) { await redis.set(_mapCacheKey, _mapDots, { ex: 604800 }); console.log('Map dots cached (7-day TTL)'); }
        } catch(e) { console.warn('Map dots cache write failed:', e.message); }
      }
    }
    omContent._mapDots = _mapDots || null;

    // Attach A.CRE data for renderer
    omContent._acreData = {
      county:              acreData.county,
      msa:                 acreData.msa,
      sources:             acreData.sources,
      rates:               resolvedRates,
      rateSources,
      rateSheet:           acreData.rateSheet           || null,
      census:              acreData.census              || null,
      employment:          acreData.employment          || null,
      permits:             acreData.permits             || null,
      economicIndicators:  acreData.economicIndicators  || null,
      market: {
        stalledPipelineUnits: acreData.market?.stalledPipelineUnits ?? null,
        vacancyRate:          _webVacancy
      }
    };

    console.log(`═══ OM generation complete for: ${inputs.propName} ═══\n`);
    res.json({ success: true, content: omContent });

  } catch (err) {
    console.error("Generation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── FILE PARSING ─────────────────────────────────────────────────────────────
app.post("/api/parse-file", upload.single("file"), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  if (!req.file) return res.status(400).json({ error: "No file received" });

  const fileType = req.body.fileType || "t12";
  const filename = req.file.originalname || "uploaded_file";
  console.log(`Parsing file: ${filename}, type: ${fileType}, size: ${req.file.size} bytes`);

  // CSV handling
  if (filename.toLowerCase().endsWith(".csv")) {
    const lines = req.file.buffer.toString("utf8").split("\n").filter(l => l.trim());
    const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
    const rows = lines.slice(1, 8).map(l => l.split(",").map(c => c.replace(/"/g, "").trim()));
    return mapColumns(res, fileType, headers, rows);
  }

  // Excel handling
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true, raw: false });
    const results = {};

    wb.SheetNames.forEach(name => {
      const sheet = wb.Sheets[name];
      if (!sheet) return;
      let json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false, raw: false });
      json = json.filter(row => row.some(c => c !== "" && c !== null));
      if (json.length === 0) return;

      let headerRow = 0;
      for (let i = 0; i < Math.min(15, json.length); i++) {
        const nonEmpty = json[i].filter(c => c && String(c).trim());
        if (nonEmpty.length >= 2 && nonEmpty.some(c => /[a-zA-Z]/.test(String(c)))) {
          headerRow = i; break;
        }
      }

      const headers = (json[headerRow] || []).map(h => String(h || "").trim());
      const rows = json.slice(headerRow + 1, headerRow + 10);
      const allRows = json.slice(headerRow + 1); // full data rows for rawRows extraction
      if (headers.filter(Boolean).length > 0) results[name] = { headers, rows, allRows, totalRows: json.length - headerRow - 1 };
    });

    if (Object.keys(results).length === 0) {
      return res.json({ success: true, mappings: {}, summary: { note: "No readable data found — try saving as CSV" } });
    }

    const best = Object.entries(results).sort((a, b) => b[1].totalRows - a[1].totalRows)[0];
    console.log(`Using sheet: ${best[0]}, headers: ${best[1].headers.slice(0, 6).join(", ")}`);
    return mapColumns(res, fileType, best[1].headers, best[1].rows, best[1].allRows);

  } catch (err) {
    console.error("Excel parse error:", err.message);
    return res.json({ success: true, mappings: {}, summary: { note: `Parse error: ${err.message} — try saving as CSV` } });
  }
});

async function mapColumns(res, fileType, headers, rows, allRows) {
  // ── Build rawRows: find most recent year column, extract label→value pairs ──
  let rawRows = [];
  if (fileType === "t12" && allRows && allRows.length > 0) {
    // Find most recent year column: scan headers for 4-digit years, pick highest
    let recentYearCol = -1;
    let recentYear = 0;
    headers.forEach((h, i) => {
      const m = String(h).match(/\b(20\d{2}|19\d{2})\b/);
      if (m) {
        const yr = parseInt(m[1]);
        if (yr > recentYear) { recentYear = yr; recentYearCol = i; }
      }
    });
    // If no year header found, use rightmost non-empty numeric-looking column
    if (recentYearCol === -1) {
      for (let c = headers.length - 1; c >= 1; c--) {
        const hasNum = allRows.some(row => {
          const v = String(row[c] || "").replace(/[$,()\s]/g, "");
          return v.length > 0 && !isNaN(parseFloat(v));
        });
        if (hasNum) { recentYearCol = c; break; }
      }
    }
    console.log(`T12 rawRows: most recent year col=${recentYearCol} (year=${recentYear || "rightmost"})`);
    if (recentYearCol > 0) {
      const parseCell = (v) => {
        const s = String(v || "").trim();
        if (!s) return null;
        const neg = s.includes("(") || s.startsWith("-");
        const n = parseFloat(s.replace(/[$,()\s]/g, ""));
        if (isNaN(n) || n === 0) return null;
        return neg ? -Math.abs(n) : Math.abs(n);
      };
      allRows.forEach(row => {
        const label = String(row[0] || "").trim();
        if (!label || /^\d{4}$/.test(label)) return; // skip blank or year-only labels
        const value = parseCell(row[recentYearCol]);
        if (label && value !== null) rawRows.push({ label, value });
      });
      console.log(`T12 rawRows extracted: ${rawRows.length} entries`);
    }
  }

  try {
    const result = await anthropicCall({
      model: "claude-sonnet-4-5",
      max_tokens: 800,
      system: "You are a CRE financial data parser. Return ONLY a raw JSON object. No markdown, no backticks. Start with { and end with }.",
      messages: [{
        role: "user",
        content: `Map columns for a "${fileType}" CRE spreadsheet.
Headers: ${JSON.stringify(headers.slice(0, 20))}
Sample rows: ${JSON.stringify(rows.slice(0, 5))}
Return: {"mappings":{"standardField":"actualColumnHeader"},"summary":{"Label":"$value"}}
For t12: find EGI, vacancy, opex, NOI, management, taxes, insurance, maintenance.
For rentRoll: find unit, type, SF, in-place rent, market rent, lease dates, status.
For proForma: find EGI, vacancy, NOI, expenses, stabilized NOI, years.
Summary: up to 8 key financial figures with formatted values.`
      }]
    }, false);

    const text = (result.body.content || []).find(c => c.type === "text")?.text || "{}";
    const parsed = extractJSON(text);
    console.log(`Column mapping success. Mappings: ${Object.keys(parsed.mappings || {}).length}`);
    res.json({ success: true, mappings: parsed.mappings || {}, summary: parsed.summary || {}, rawRows });
  } catch (err) {
    console.error("Column mapping error:", err.message);
    res.json({ success: true, mappings: {}, summary: { note: "File uploaded — column mapping failed" }, rawRows });
  }
}

// ─── PROMPT BUILDER ───────────────────────────────────────────────────────────
function buildPrompt(i, dataContext, parsedFiles) {
  const fileContext = Object.keys(parsedFiles).length > 0
    ? `UPLOADED FINANCIALS:\n${Object.entries(parsedFiles).map(([t, d]) => `${t.toUpperCase()}: ${JSON.stringify(d.summary || {})}`).join("\n")}`
    : "No financial files uploaded.";

  const userRisks = i.risks
    ? `User specified these risks to include: ${i.risks}. Auto-identify additional risks to reach 5-6 total.`
    : "Auto-identify the 5-6 most material risks based on asset type, market data, and financing structure.";

  return `Generate a comprehensive lender-focused offering memorandum using the pre-researched data below.

═══════════════════════════════════════
PRE-RESEARCHED MARKET DATA
Use A.CRE data authoritatively for all numbers.
Use web research for qualitative narrative support.
═══════════════════════════════════════
${dataContext}

═══════════════════════════════════════
DEAL INPUTS (authoritative)
═══════════════════════════════════════
Property: ${i.propName}, ${i.address}, ${i.city} ${i.state}
Asset: ${i.assetType} | Built: ${i.yearBuilt}${i.yearReno ? " / Reno: " + i.yearReno : ""}
Units/SF: ${i.totalUnits || i.totalSF} | Stories: ${i.stories} | Mix: ${i.unitMix}
Amenities: ${i.amenities} | Parking: ${i.parking} | CapEx: ${i.capex}
Price: ${i.askingPrice} | NOI: ${i.noi} | Cap: ${i.capRate}% | Occ: ${i.occupancy}%
PF NOI: ${i.proFormaNOI} | Exit cap: ${i.exitCap}%
Loan: ${i.loanType} | Amount: ${i.loanAmt} | Term: ${i.loanTerm} | Recourse: ${i.recourse}
LTC: ${i.ltc}% | LTV: ${i.ltv}% | DY: ${i.dy}% | Guarantor: ${i.guarantor}
S&U: ${i.sourcesUses}
Market: ${i.market} | Strategy: ${i.strategy}
Value-add: ${i.valueAdd}
Sponsor: ${i.sponsorName} | Track: ${i.sponsorTrack}
Broker: ${i.brokerName} | Tagline: ${i.tagline || "generate one"}
${fileContext}

═══════════════════════════════════════
RISK SCORING INSTRUCTIONS
${userRisks}
Score each risk:
- Likelihood (L) 1-10: Confirmed(9-10), Highly Probable(7-8), Plausible(5-6), Possible(3-4), Unlikely(1-2)
- Severity (S) 1-10: Thesis-Destroying(9-10), Return-Impairing(7-8), Meaningful Drag(5-6), Manageable(3-4), Negligible(1-2)
- Priority = L×S: Critical≥56(red), High 35-55(orange), Moderate 18-34(yellow), Low<18(green)
- Trajectory: ▼deteriorating / ►stable / ▲improving — cite specific data point
- Evidence: cite A.CRE data or web research source
- For Critical/High: include specific underwriting adjustment (%, $, or timeline)
═══════════════════════════════════════

Return JSON with these exact keys:
- tagline (8-12 words)
- executiveSummary (4-5 sentences — cite specific rates and market figures from data)
- financingNarrative (3 sentences — reference actual current Treasury yields)
- financingRateContext (2-3 sentences — "As of today the 10Y Treasury is at X%..." cite A.CRE data)
- agencyRateSheetNarrative (2 sentences — reference actual Freddie Mac spread data)
- investmentHighlights (array of 6 strings — each must start with a SHORT 2-4 word punchy headline in title case, followed by " — " and then 2-3 sentences of supporting detail. Example format: "Top-Decile Demographics — Bethesda's median HHI of $192K ranks in the 97th national percentile...". Headlines must be eye-catching and specific, NOT full sentences or data strings.)
- risksAndMitigants (array of 5-6 objects: risk, mitigant, likelihood, likelihoodTier, severity, severityTier, priority, priorityLabel, priorityColor, trajectory, trajectoryLabel, evidence, underwrtingAdj)
- heatMapNarrative (3 sentences — cite Supply Pressure Index and Demand Index scores)
- propertyOverview (3-4 sentences — past/present/future)
- propertyCondition (2 sentences — physical condition and CapEx)
- locationEmployers (2-3 sentences — cite top employment sectors from A.CRE data)
- locationMajorEmployers (array of up to 5 objects { name, employees } — specific named companies and organizations that are major employers near this property; use EMPLOYMENT top employers data; employees as integer headcount e.g. 11100; ONLY real named companies — never industry sector labels like "Professional Services" or "Public Administration")
- locationRetail (array of up to 4 objects { name, desc, distance, mode } — anchor retail centers, groceries, lifestyle districts near the property; use LOCATION AMENITIES distanceMiles values exactly as searched — do NOT estimate distances; format as "~X.X mi"; mode "walk" if distanceMiles <= 0.6 else "drive")
- locationEducation (array of up to 4 objects { name, desc, distance, mode } — schools and universities near the property; use LOCATION AMENITIES distanceMiles values exactly as searched — do NOT estimate distances; format as "~X.X mi"; mode "walk" if distanceMiles <= 0.6 else "drive")
- locationTransit (array of up to 4 objects { name, desc, distance, mode } — metro stations, highway interchanges, airports near the property; use LOCATION AMENITIES distanceMiles values exactly as searched — do NOT estimate distances; format as "~X.X mi"; mode "walk" if distanceMiles <= 0.6 else "drive")
- marketOverview (3-4 sentences — cite vacancy rates and rent figures from web research)
- marketSupplyDemand (2-3 sentences — cite Supply Pressure Index score and percentile)
- marketEmploymentNarrative (2-3 sentences — cite Property Demand Index score)
- marketRentComps (2-3 sentences — cite specific rent figures from web research)
- marketMacroBackdrop (2-3 sentences — cite rate environment from A.CRE data)
- macroHeroHeadline (1 high-impact narrative sentence, max 150 characters — describe the macro environment and what it means for this deal in qualitative terms only. No data points, no percentages, no specific numbers. Write in the voice of a senior capital markets advisor. Example style: "Inflation re-accelerating and construction costs elevated, but agency credit stays open — a workable window for stabilized 10-year execution." Make it deal-relevant and forward-looking.)
- macroNarrativeShort (exactly 2-3 sentences of concise narrative — Sentence 1: weave in the live 10Y UST rate, Freddie MF rate, and CPI YoY with directional language (e.g. "re-accelerating", "cooling", "holding steady"). Sentence 2: frame shelter inflation for rent implications — use the actual shelterInflation figure and describe whether it underpins, moderates, or pressures rent growth. Sentence 3: frame construction cost YoY for supply implications — use the actual constructionCostYoY figure and describe whether it suppresses, moderates, or stimulates new supply. Each sentence must reflect the actual direction of the data. Bold key numbers using <b>X%</b> HTML tags.)
- financialSummaryNarrative (2 sentences — contextualize deal metrics vs market)
- sponsorOverview (3-4 sentences)
- sponsorGlanceFacts (array of up to 5 objects {label, value} — extract structured facts from inputs.sponsorTrack and inputs.sponsorName. Only include facts explicitly stated — never fabricate. Typical labels: "Experience", "Focus", "Markets", "Strategy", "Role on Deal". Values should be short — e.g. "10 Years", "Class A Multifamily", "DC · MD · VA", "Value-Add", "Guarantor · Non-Recourse". Return [] if track record is empty.)
- sponsorApproachPillars (array of exactly 3 objects {title, body} — distill 3 investment approach pillars from the sponsor narrative and track record. Title: 2-4 words, Cormorant-style headline. Body: 1-2 sentences, max 25 words, grounded only in what the sponsor actually wrote. Return [] if insufficient information.)`;
}

// ─── JSON EXTRACTOR ───────────────────────────────────────────────────────────
function extractJSON(text) {
  if (!text || !text.trim()) throw new Error('Empty response');
  let c = text.replace(/```\w*/gi,'').replace(/`/g,'').trim();
  try { return JSON.parse(c); } catch {}
  const si = c.indexOf('{'), ei = c.lastIndexOf('}');
  if (si !== -1 && ei > si) { try { return JSON.parse(c.slice(si, ei+1)); } catch {} }
  const m = c.match(/{[sS]*}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('Cannot parse JSON. Preview: ' + text.slice(0,200));
}

// ─── MAP IMAGE PROXY ──────────────────────────────────────────────────────────
app.get("/api/map-image", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(404).json({ error: "GOOGLE_MAPS_API_KEY not configured" });
  const address = req.query.address || "";
  const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(address)}&zoom=15&size=800x500&maptype=satellite&markers=color:red%7C${encodeURIComponent(address)}&key=${key}`;
  https.get(mapUrl, (mapRes) => {
    res.setHeader("Content-Type", mapRes.headers["content-type"] || "image/png");
    mapRes.pipe(res);
  }).on("error", (err) => res.status(500).json({ error: err.message }));
});

// ─── START ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
