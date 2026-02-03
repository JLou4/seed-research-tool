// Web search integration using Brave Search API
// Searches multiple high-signal sources per PLAN.md
// Falls back gracefully if API key not available

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Search the web for startups matching keywords
 * @param {string} query - Search query
 * @param {number} count - Number of results (max 20)
 * @returns {Promise<Array>} - Array of search results
 */
export async function searchWeb(query, count = 10) {
  if (!BRAVE_API_KEY) {
    console.warn('BRAVE_API_KEY not set, skipping web search');
    return [];
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: Math.min(count, 20),
      freshness: 'py', // Past year
    });

    const response = await fetch(`${BRAVE_BASE_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    });

    if (!response.ok) {
      console.error('Brave search error:', response.status);
      return [];
    }

    const data = await response.json();
    return (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
      source: 'brave',
    }));
  } catch (error) {
    console.error('Brave search failed:', error.message);
    return [];
  }
}

/**
 * Search for startup companies matching a thesis
 * Searches all TIER 1 and TIER 2 sources from PLAN.md:
 * - YC Directory (via search)
 * - Hacker News "Show HN"
 * - TechCrunch stealth launches
 * - arXiv papers with company affiliations
 * - Seed VC portfolios
 */
export async function searchStartups(keywords, limit = 20) {
  const results = [];
  const seen = new Set();

  // TIER 1: High-signal startup-specific searches
  const tier1Queries = [
    // YC Directory & batches
    `site:ycombinator.com/companies ${keywords}`,
    `"Y Combinator" "${keywords}" startup 2024 2025`,
    `YC W24 S24 ${keywords} startup`,
    
    // Hacker News Show HN (MVP launches)
    `site:news.ycombinator.com "Show HN" ${keywords}`,
    
    // Founder/team signals on X/Twitter
    `site:x.com "${keywords}" "building" OR "stealth" OR "pre-seed"`,
    
    // LinkedIn "first engineer" signals
    `site:linkedin.com "first engineer" OR "founding engineer" ${keywords}`,
  ];

  // TIER 2: Database & publication searches
  const tier2Queries = [
    // TechCrunch stealth launches
    `site:techcrunch.com "${keywords}" "stealth" OR "seed round" OR "raises" 2024`,
    
    // arXiv papers → startups (author affiliations)
    `site:arxiv.org ${keywords} startup OR company OR founded`,
    
    // Seed VC portfolio pages
    `"portfolio" "${keywords}" seed OR pre-seed venture 2024`,
    `site:a16z.com OR site:sequoia.com OR site:greylock.com ${keywords} startup`,
    
    // General startup funding
    `${keywords} startup funding seed round 2024`,
    `${keywords} early stage company Series A 2024`,
    `${keywords} startup founded 2023 2024 2025`,
    `${keywords} venture backed startup seed`,
  ];

  // Search TIER 1 first (higher signal)
  console.log(`[WebSearch] Searching TIER 1 sources for: ${keywords}`);
  for (const query of tier1Queries) {
    const searchResults = await searchWeb(query, 5);
    
    for (const result of searchResults) {
      try {
        const domain = new URL(result.url).hostname.replace('www.', '');
        if (!seen.has(domain) && !isNewsOrListSite(domain)) {
          seen.add(domain);
          results.push({
            ...result,
            domain,
            query,
            tier: 1,
          });
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }
  }
  console.log(`[WebSearch] TIER 1: Found ${results.length} unique results`);

  // Search TIER 2 if we need more
  if (results.length < limit) {
    console.log(`[WebSearch] Searching TIER 2 sources...`);
    for (const query of tier2Queries) {
      const searchResults = await searchWeb(query, 5);
      
      for (const result of searchResults) {
        try {
          const domain = new URL(result.url).hostname.replace('www.', '');
          if (!seen.has(domain) && !isNewsOrListSite(domain)) {
            seen.add(domain);
            results.push({
              ...result,
              domain,
              query,
              tier: 2,
            });
          }
        } catch (e) {
          // Invalid URL, skip
        }
      }

      if (results.length >= limit) break;
    }
  }
  console.log(`[WebSearch] Total: Found ${results.length} unique companies`);

  // Sort by tier (TIER 1 first)
  results.sort((a, b) => (a.tier || 2) - (b.tier || 2));

  return results.slice(0, limit);
}

/**
 * Filter out news sites and aggregators
 */
function isNewsOrListSite(domain) {
  const excludedDomains = [
    'techcrunch.com', 'forbes.com', 'bloomberg.com', 'reuters.com',
    'crunchbase.com', 'pitchbook.com', 'linkedin.com', 'twitter.com',
    'medium.com', 'substack.com', 'wikipedia.org', 'wired.com',
    'venturebeat.com', 'theverge.com', 'arstechnica.com', 'ycombinator.com',
    'news.ycombinator.com', 'reddit.com', 'producthunt.com',
  ];
  return excludedDomains.some(d => domain.includes(d));
}

export function isWebSearchAvailable() {
  return !!BRAVE_API_KEY;
}

/**
 * Search for thesis-validating sources (patents, research, newsletters, articles)
 * These citations support the investment thesis itself, not specific companies
 * 
 * TIERED PRIORITIZATION:
 * - Tier 1 (⭐⭐⭐): Patents, Academic Research (arxiv, IEEE, SSRN, nature, pubmed)
 * - Tier 2 (⭐⭐): VC Research, Consulting Reports, Quality Newsletters
 * - Tier 3 (⭐): Market reports, general articles (only if Tier 1+2 insufficient)
 * 
 * FRESHNESS: Only sources from 2022+ (4-year window)
 */
export async function searchThesisSources(thesis, keywords, limit = 10) {
  if (!BRAVE_API_KEY) {
    console.warn('BRAVE_API_KEY not set, skipping thesis source search');
    return [];
  }

  const results = [];
  const seen = new Set();
  const keywordStr = keywords.slice(0, 2).join(' ');
  
  // TIER 1: High-quality academic + patents (⭐⭐⭐)
  const tier1Queries = [
    // Patents
    `site:patents.google.com ${keywordStr}`,
    `site:uspto.gov ${keywordStr} patent`,
    
    // Academic research papers
    `site:arxiv.org ${keywordStr}`,
    `site:ieee.org ${keywordStr}`,           // IEEE Xplore
    `site:ieeexplore.ieee.org ${keywordStr}`, // IEEE Xplore direct
    `site:ssrn.com ${keywordStr}`,           // SSRN (economics/finance)
    `site:nature.com ${keywordStr}`,
    `site:sciencedirect.com ${keywordStr}`,
    `site:pubmed.gov ${keywordStr}`,
    `site:ncbi.nlm.nih.gov ${keywordStr}`,   // PubMed/NCBI
  ];
  
  // TIER 2: VC research + consulting reports (⭐⭐)
  const tier2Queries = [
    // VC research blogs
    `site:a16z.com ${keywords[0]}`,
    `site:sequoia.com ${keywords[0]}`,
    `site:greylock.com ${keywords[0]}`,
    `site:nfx.com ${keywords[0]}`,
    
    // Consulting reports
    `site:mckinsey.com ${keywords[0]}`,
    `site:bcg.com ${keywords[0]}`,
    `site:bain.com ${keywords[0]}`,
    
    // Quality newsletters
    `site:substack.com ${keywordStr} market analysis 2024 2025 2026`,
    
    // YC library
    `site:ycombinator.com/library ${keywords[0]}`,
  ];
  
  // TIER 3: General market reports (⭐) - only if needed
  const tier3Queries = [
    `"${keywords[0]}" market report 2024 2025 2026`,
    `"${keywords[0]}" industry trends analysis 2024`,
    `"${keywords[0]}" market size TAM growth 2024 2025`,
    `"${keywords[0]}" investment thesis venture capital 2024`,
  ];

  // Domains to completely exclude (aggregators, low-quality)
  const excludedDomains = [
    'omdena.com', 'startus-insights.com', 'tracxn.com', 'cbinsights.com',
    'medium.com', 'wikipedia.org', 'reddit.com', 'quora.com',
    'linkedin.com', 'twitter.com', 'x.com', 'facebook.com',
  ];

  // Helper to check source quality tier
  const getSourceTier = (url) => {
    const u = url.toLowerCase();
    // Tier 1: Academic + Patents
    if (u.includes('arxiv.org') || u.includes('ieee.org') || u.includes('ieeexplore') ||
        u.includes('ssrn.com') || u.includes('nature.com') || u.includes('sciencedirect') ||
        u.includes('pubmed') || u.includes('ncbi.nlm.nih.gov') ||
        u.includes('patents.google') || u.includes('uspto.gov')) {
      return 1;
    }
    // Tier 2: VC + Consulting
    if (u.includes('a16z.com') || u.includes('sequoia.com') || u.includes('greylock') ||
        u.includes('nfx.com') || u.includes('mckinsey') || u.includes('bcg.com') ||
        u.includes('bain.com') || u.includes('ycombinator.com/library')) {
      return 2;
    }
    // Tier 3: Everything else that passes
    return 3;
  };

  // Helper to categorize source type
  const categorizeSource = (url, title) => {
    const u = url.toLowerCase();
    const t = title.toLowerCase();
    if (u.includes('patent') || u.includes('uspto')) return 'patent';
    if (u.includes('arxiv') || u.includes('ieee') || u.includes('ssrn') || 
        u.includes('nature.com') || u.includes('sciencedirect') || 
        u.includes('pubmed') || u.includes('ncbi')) return 'research';
    if (u.includes('substack')) return 'newsletter';
    if (u.includes('a16z') || u.includes('sequoia') || u.includes('greylock') ||
        u.includes('nfx') || u.includes('ycombinator')) return 'vc_research';
    if (u.includes('mckinsey') || u.includes('bcg') || u.includes('bain')) return 'consulting';
    if (t.includes('report') || t.includes('market size')) return 'report';
    return 'article';
  };

  // Helper to check if URL is excluded
  const isExcluded = (url) => {
    const u = url.toLowerCase();
    return excludedDomains.some(d => u.includes(d));
  };

  console.log(`[ThesisSources] Searching TIER 1 (academic/patents)...`);
  
  // Search TIER 1 first (high-quality sources)
  for (const query of tier1Queries) {
    try {
      // Use freshness filter: 4 years (we're in 2026, so 2022+)
      const searchResults = await searchWebWithFreshness(query, 3, 'py'); // Past year first, then expand
      
      for (const result of searchResults) {
        const urlKey = result.url.toLowerCase();
        if (!seen.has(urlKey) && !isExcluded(result.url)) {
          seen.add(urlKey);
          results.push({
            title: result.title,
            url: result.url,
            description: result.description,
            type: categorizeSource(result.url, result.title),
            tier: getSourceTier(result.url),
            query: query,
          });
        }
      }
    } catch (e) {
      console.error(`[ThesisSources] TIER 1 query failed: ${query}`, e.message);
    }
  }
  
  console.log(`[ThesisSources] TIER 1 found ${results.length} sources`);

  // Search TIER 2 if we need more
  if (results.length < limit) {
    console.log(`[ThesisSources] Searching TIER 2 (VC/consulting)...`);
    for (const query of tier2Queries) {
      try {
        const searchResults = await searchWebWithFreshness(query, 3, 'py');
        
        for (const result of searchResults) {
          const urlKey = result.url.toLowerCase();
          if (!seen.has(urlKey) && !isExcluded(result.url)) {
            seen.add(urlKey);
            results.push({
              title: result.title,
              url: result.url,
              description: result.description,
              type: categorizeSource(result.url, result.title),
              tier: getSourceTier(result.url),
              query: query,
            });
          }
        }
        if (results.length >= limit) break;
      } catch (e) {
        console.error(`[ThesisSources] TIER 2 query failed: ${query}`, e.message);
      }
    }
    console.log(`[ThesisSources] After TIER 2: ${results.length} sources`);
  }

  // Search TIER 3 only if still need more (backfill)
  if (results.length < Math.floor(limit * 0.6)) {
    console.log(`[ThesisSources] Searching TIER 3 (backfill)...`);
    for (const query of tier3Queries) {
      try {
        const searchResults = await searchWebWithFreshness(query, 3, 'py');
        
        for (const result of searchResults) {
          const urlKey = result.url.toLowerCase();
          if (!seen.has(urlKey) && !isExcluded(result.url)) {
            seen.add(urlKey);
            results.push({
              title: result.title,
              url: result.url,
              description: result.description,
              type: categorizeSource(result.url, result.title),
              tier: getSourceTier(result.url),
              query: query,
            });
          }
        }
        if (results.length >= limit) break;
      } catch (e) {
        console.error(`[ThesisSources] TIER 3 query failed: ${query}`, e.message);
      }
    }
  }

  // Sort by tier (1 first, then 2, then 3)
  results.sort((a, b) => (a.tier || 3) - (b.tier || 3));

  console.log(`[ThesisSources] Found ${results.length} validating sources (Tier breakdown: ${results.filter(r => r.tier === 1).length} T1, ${results.filter(r => r.tier === 2).length} T2, ${results.filter(r => r.tier === 3).length} T3)`);
  return results.slice(0, limit);
}

/**
 * Search web with explicit freshness parameter
 * @param {string} query - Search query
 * @param {number} count - Number of results
 * @param {string} freshness - 'pd' (day), 'pw' (week), 'pm' (month), 'py' (year), or date range
 */
async function searchWebWithFreshness(query, count = 10, freshness = 'py') {
  if (!BRAVE_API_KEY) return [];

  try {
    const params = new URLSearchParams({
      q: query,
      count: Math.min(count, 20),
      freshness: freshness,
    });

    const response = await fetch(`${BRAVE_BASE_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    });

    if (!response.ok) {
      console.error('Brave search error:', response.status);
      return [];
    }

    const data = await response.json();
    return (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
      source: 'brave',
    }));
  } catch (error) {
    console.error('Brave search failed:', error.message);
    return [];
  }
}
