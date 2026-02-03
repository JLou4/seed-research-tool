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
 */
export async function searchThesisSources(thesis, keywords, limit = 10) {
  if (!BRAVE_API_KEY) {
    console.warn('BRAVE_API_KEY not set, skipping thesis source search');
    return [];
  }

  const results = [];
  const seen = new Set();

  // Search queries for thesis validation sources
  const sourceQueries = [
    // Patents
    `site:patents.google.com ${keywords.slice(0, 2).join(' ')}`,
    `site:uspto.gov ${keywords.slice(0, 2).join(' ')} patent`,
    
    // Research papers
    `site:arxiv.org ${keywords.slice(0, 2).join(' ')}`,
    `site:nature.com ${keywords.slice(0, 2).join(' ')}`,
    `site:sciencedirect.com ${keywords.slice(0, 2).join(' ')}`,
    
    // Industry newsletters & analysis
    `site:substack.com ${keywords.slice(0, 2).join(' ')} market analysis`,
    `"${keywords[0]}" market report 2024 2025`,
    `"${keywords[0]}" industry trends analysis`,
    
    // News & market validation
    `"${keywords[0]}" market size TAM growth 2024`,
    `"${keywords[0]}" investment thesis venture capital`,
    
    // YC & startup ecosystem validation
    `site:ycombinator.com/library ${keywords[0]}`,
    `"${keywords[0]}" startup ecosystem report`,
  ];

  console.log(`[ThesisSources] Searching for validating sources...`);
  
  for (const query of sourceQueries) {
    try {
      const searchResults = await searchWeb(query, 3);
      
      for (const result of searchResults) {
        const urlKey = result.url.toLowerCase();
        if (!seen.has(urlKey)) {
          seen.add(urlKey);
          
          // Categorize the source
          let sourceType = 'article';
          const url = result.url.toLowerCase();
          if (url.includes('patent') || url.includes('uspto')) {
            sourceType = 'patent';
          } else if (url.includes('arxiv') || url.includes('nature.com') || url.includes('sciencedirect')) {
            sourceType = 'research';
          } else if (url.includes('substack')) {
            sourceType = 'newsletter';
          } else if (url.includes('report') || result.title.toLowerCase().includes('report')) {
            sourceType = 'report';
          }
          
          results.push({
            title: result.title,
            url: result.url,
            description: result.description,
            type: sourceType,
            query: query,
          });
        }
      }
      
      if (results.length >= limit) break;
    } catch (e) {
      console.error(`[ThesisSources] Query failed: ${query}`, e.message);
    }
  }

  console.log(`[ThesisSources] Found ${results.length} validating sources`);
  return results.slice(0, limit);
}
