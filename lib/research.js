import Anthropic from '@anthropic-ai/sdk';
import { searchOrganizations, enrichCompany, isCrunchbaseAvailable } from './crunchbase.js';
import { searchStartups, searchThesisSources, isWebSearchAvailable } from './websearch.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * STEP 1: Analyze thesis and generate search terms + adjacent themes for discovery
 */
const KEYWORD_PROMPT = `You are a seed-stage investment analyst. Given an investment thesis, generate search keywords AND adjacent investment themes based on second/third-order effects.

ADJACENT THEMES are critical - they should capture:
1. SECOND-ORDER EFFECTS: If this thesis succeeds, what else must grow? (enablers, suppliers, infrastructure)
2. THIRD-ORDER EFFECTS: What downstream industries benefit from #1 succeeding?
3. PICKS & SHOVELS: Who sells tools to companies in this space?
4. PARALLEL PLAYS: Same technology, different vertical application

Example for "autonomous trucking":
- 2nd order: Fleet management software, truck platooning tech, highway sensor infrastructure
- 3rd order: Truck stop automation, long-haul driver retraining, freight insurance AI
- Picks & shovels: HD mapping for highways, V2X communication chips, safety certification services

Return JSON only:
{
  "primary_keywords": ["keyword1", "keyword2"],  // 3-5 most direct keywords
  "adjacent_themes": [
    {
      "theme": "Short searchable theme (4-6 words)",
      "order": "2nd" | "3rd" | "picks_shovels" | "parallel",
      "rationale": "One sentence on why this is investable if main thesis succeeds"
    }
  ],  // 5-8 adjacent themes with order classification
  "crunchbase_categories": ["category1"],        // Crunchbase industry categories
  "search_queries": ["query1", "query2"],        // 5-8 specific search queries for finding startups
  "public_comps": ["TICKER1", "TICKER2"],        // 3-5 public company tickers to monitor
  "thesis_summary": "One paragraph summary of the investment thesis and what makes it compelling"
}`;

async function generateSearchTerms(thesis) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `${KEYWORD_PROMPT}\n\nINVESTMENT THESIS: "${thesis}"`
    }],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse keyword response');
  
  return JSON.parse(jsonMatch[0]);
}

/**
 * STEP 2: Search AGGRESSIVELY for real companies across ALL sources
 * - Run Brave AND Crunchbase in parallel
 * - Use multiple search variations
 */
async function findRealCompanies(searchTerms, progressCallback) {
  const companies = [];
  const seen = new Set();

  // Define early-stage funding types we want to prioritize
  const EARLY_STAGE_TYPES = ['seed', 'pre_seed', 'angel', 'grant', 'convertible_note', 'series_a'];
  const LATE_STAGE_TYPES = ['series_b', 'series_c', 'series_d', 'series_e', 'series_f', 'series_g', 'private_equity', 'post_ipo_equity', 'post_ipo_debt', 'post_ipo_secondary', 'ipo'];
  
  const addCompany = (company) => {
    const key = company.name.toLowerCase().trim();
    if (!seen.has(key) && company.name.length > 1 && company.name.length < 100) {
      // FILTER OUT late-stage companies (Series B+, public)
      const fundingType = (company.last_funding_type || '').toLowerCase().replace(/[\s-]/g, '_');
      if (LATE_STAGE_TYPES.includes(fundingType)) {
        console.log(`Skipping late-stage company: ${company.name} (${company.last_funding_type})`);
        return; // Skip this company
      }
      
      // Determine funding stage for display
      let funding_stage = 'unknown';
      if (EARLY_STAGE_TYPES.includes(fundingType)) {
        funding_stage = company.last_funding_type || 'early';
      } else if (fundingType) {
        funding_stage = company.last_funding_type;
      }
      
      seen.add(key);
      companies.push({
        ...company,
        funding_stage,
        sources: company.sources || [], // Initialize sources array
      });
    }
  };

  // Run Crunchbase and Brave searches in parallel
  const searchPromises = [];

  // CRUNCHBASE SEARCHES - Multiple query variations
  if (isCrunchbaseAvailable()) {
    progressCallback('Searching Crunchbase...');
    
    // Search with primary keywords
    for (const keyword of searchTerms.primary_keywords.slice(0, 3)) {
      searchPromises.push(
        searchOrganizations(keyword, 8)
          .then(results => {
            for (const org of results) {
              const name = org.properties?.identifier?.value;
              if (name) {
                const cbUrl = `https://www.crunchbase.com/organization/${name.toLowerCase().replace(/\s+/g, '-')}`;
                addCompany({
                  name,
                  source: 'crunchbase',
                  description: org.properties?.short_description || '',
                  website: org.properties?.website_url?.value || '',
                  founded_year: org.properties?.founded_on?.value?.split('-')[0],
                  funding_total: org.properties?.funding_total?.value_usd,
                  last_funding_type: org.properties?.last_funding_type,
                  crunchbase_verified: true,
                  crunchbase_data: org.properties,
                  sources: [{ type: 'crunchbase', url: cbUrl, label: 'Crunchbase' }],
                });
              }
            }
          })
          .catch(e => console.error('Crunchbase search error:', e.message))
      );
    }

    // Search with search queries too
    for (const query of searchTerms.search_queries.slice(0, 3)) {
      const firstWord = query.split(' ')[0];
      searchPromises.push(
        searchOrganizations(firstWord, 5)
          .then(results => {
            for (const org of results) {
              const name = org.properties?.identifier?.value;
              if (name) {
                const cbUrl2 = `https://www.crunchbase.com/organization/${name.toLowerCase().replace(/\s+/g, '-')}`;
                addCompany({
                  name,
                  source: 'crunchbase',
                  description: org.properties?.short_description || '',
                  website: org.properties?.website_url?.value || '',
                  founded_year: org.properties?.founded_on?.value?.split('-')[0],
                  funding_total: org.properties?.funding_total?.value_usd,
                  last_funding_type: org.properties?.last_funding_type,
                  crunchbase_verified: true,
                  crunchbase_data: org.properties,
                  discovery_source: 'primary_thesis',
                  sources: [{ type: 'crunchbase', url: cbUrl2, label: 'Crunchbase' }],
                });
              }
            }
          })
          .catch(e => console.error('Crunchbase query search error:', e.message))
      );
    }
    
    // Search Crunchbase for ADJACENT THEMES (2nd/3rd order effects)
    const themeStrings = (searchTerms.adjacent_themes || []).map(t => 
      typeof t === 'string' ? t : t.theme
    ).filter(Boolean);
    
    for (const theme of themeStrings.slice(0, 3)) {
      const themeKeyword = theme.split(' ')[0]; // Use first word for Crunchbase
      searchPromises.push(
        searchOrganizations(themeKeyword, 5)
          .then(results => {
            for (const org of results) {
              const name = org.properties?.identifier?.value;
              if (name) {
                const cbUrl3 = `https://www.crunchbase.com/organization/${name.toLowerCase().replace(/\s+/g, '-')}`;
                addCompany({
                  name,
                  source: 'crunchbase',
                  description: org.properties?.short_description || '',
                  website: org.properties?.website_url?.value || '',
                  founded_year: org.properties?.founded_on?.value?.split('-')[0],
                  funding_total: org.properties?.funding_total?.value_usd,
                  last_funding_type: org.properties?.last_funding_type,
                  crunchbase_verified: true,
                  crunchbase_data: org.properties,
                  discovery_source: 'adjacent_theme',
                  discovered_via_theme: theme,
                  sources: [{ type: 'crunchbase', url: cbUrl3, label: 'Crunchbase' }],
                });
              }
            }
          })
          .catch(e => console.error(`Crunchbase (${theme}) error:`, e.message))
      );
    }
  }

  // BRAVE WEB SEARCHES - Primary thesis + adjacent themes
  if (isWebSearchAvailable()) {
    progressCallback('Searching web sources...');
    
    // Extract theme strings from adjacent_themes (handles both old string[] and new object[] format)
    const themeStrings = (searchTerms.adjacent_themes || []).map(t => 
      typeof t === 'string' ? t : t.theme
    ).filter(Boolean);
    
    // Search 1: Primary keywords
    const primaryKeywords = searchTerms.primary_keywords.join(' ');
    searchPromises.push(
      searchStartups(primaryKeywords + ' startup', 10)
        .then(webResults => {
          for (const result of webResults) {
            const titleParts = result.title.split(/[-–|:]/);
            const potentialName = titleParts[0].trim()
              .replace(/\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Company)\s*$/i, '')
              .trim();
            
            if (potentialName && potentialName.length > 2 && potentialName.length < 50) {
              addCompany({
                name: potentialName,
                source: 'web',
                description: result.description || '',
                website: result.url,
                crunchbase_verified: false,
                discovery_source: 'primary_thesis',
                sources: [{ type: 'web', url: result.url, label: 'Web Search' }],
              });
            }
          }
        })
        .catch(e => console.error('Web search (primary) error:', e.message))
    );
    
    // Search 2-4: Adjacent themes (2nd/3rd order effects) - search EACH theme
    progressCallback('Searching adjacent themes (2nd/3rd order effects)...');
    for (const theme of themeStrings.slice(0, 4)) {
      searchPromises.push(
        searchStartups(theme + ' startup company', 8)
          .then(webResults => {
            for (const result of webResults) {
              const titleParts = result.title.split(/[-–|:]/);
              const potentialName = titleParts[0].trim()
                .replace(/\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Company)\s*$/i, '')
                .trim();
              
              if (potentialName && potentialName.length > 2 && potentialName.length < 50) {
                addCompany({
                  name: potentialName,
                  source: 'web',
                  description: result.description || '',
                  website: result.url,
                  crunchbase_verified: false,
                  discovery_source: 'adjacent_theme',
                  discovered_via_theme: theme,
                  sources: [{ type: 'web', url: result.url, label: 'Web Search' }],
                });
              }
            }
          })
          .catch(e => console.error(`Web search (${theme}) error:`, e.message))
      );
    }
  }

  // Wait for all searches to complete
  await Promise.all(searchPromises);
  
  progressCallback(`Found ${companies.length} unique companies across all sources`);
  return companies;
}

/**
 * STEP 3: QUICK FIT FILTER - Score companies for DIRECT fit OR 2nd/3rd order relevance
 */
const FIT_FILTER_PROMPT = `You are a seed-stage investment analyst doing a QUICK fit check.

Score each company (1-10) based on relevance to the thesis OR its adjacent themes:

SCORING GUIDE:
- 9-10: DIRECT FIT - Company directly addresses the core thesis
- 7-8: 2ND ORDER - Company enables/supplies to thesis companies (picks & shovels)
- 5-6: 3RD ORDER - Company benefits if thesis succeeds (downstream effects)
- 1-4: NO FIT - Not relevant to thesis or its effects

Consider: Does this company benefit if the thesis succeeds? Even indirectly?

Return JSON only:
{
  "scores": [
    {"name": "Company Name", "fit_score": 8, "fit_type": "direct|2nd_order|3rd_order", "reason": "1 sentence why"}
  ]
}`;

async function quickFitFilter(thesis, companies, searchTerms, progressCallback) {
  if (companies.length === 0) return [];
  
  progressCallback(`Quick-scoring ${companies.length} companies for thesis + adjacent theme fit...`);

  // Prepare compact company list with discovery source
  const companyList = companies.map(c => {
    let line = `- ${c.name}: ${(c.description || '').slice(0, 80)}`;
    if (c.discovered_via_theme) line += ` [found via: ${c.discovered_via_theme}]`;
    return line;
  }).join('\n');

  // Extract theme strings for context
  const themeStrings = (searchTerms.adjacent_themes || []).map(t => 
    typeof t === 'string' ? t : `${t.theme} (${t.order || '2nd order'})`
  ).filter(Boolean);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `${FIT_FILTER_PROMPT}

THESIS: "${thesis}"

ADJACENT THEMES (2nd/3rd order effects to also consider):
${themeStrings.join('\n')}

COMPANIES TO SCORE:
${companyList}`
    }],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // If parsing fails, return all companies unfiltered
    console.warn('Fit filter parsing failed, returning all companies');
    return companies;
  }

  const result = JSON.parse(jsonMatch[0]);
  const scoreMap = new Map();
  for (const score of result.scores || []) {
    scoreMap.set(score.name.toLowerCase(), { 
      fit_score: score.fit_score, 
      fit_type: score.fit_type || 'direct',
      reason: score.reason 
    });
  }

  // Filter and annotate companies
  const filtered = companies
    .map(c => {
      const scoreData = scoreMap.get(c.name.toLowerCase());
      return {
        ...c,
        fit_score: scoreData?.fit_score || 5,
        fit_type: scoreData?.fit_type || 'direct', // direct, 2nd_order, 3rd_order
        fit_reason: scoreData?.reason || '',
      };
    })
    .filter(c => c.fit_score >= 5)  // Only keep fit_score >= 5
    .sort((a, b) => b.fit_score - a.fit_score);  // Sort by fit score

  progressCallback(`${filtered.length} companies passed fit filter (score >= 5)`);
  return filtered;
}

/**
 * STEP 4: DEEP ANALYSIS - Only for companies that passed the fit filter
 */
const ANALYSIS_PROMPT = `You are a seed-stage investment analyst. Analyze these REAL companies against an investment thesis.

CRITICAL: Only analyze the companies provided. Do NOT invent or hallucinate companies.

For each company, provide:
1. A 2-3 paragraph investment analysis explaining thesis alignment
2. Final scores (1-10 each):
   - thesis_relevance: How well does this match the thesis?
   - recency: Based on founding date if known (10 = recent, 1 = old/unknown)
   - founding_team: Based on available info (5 = unknown, adjust if you know specifics)

Return JSON:
{
  "analyzed_companies": [
    {
      "name": "Exact company name from input",
      "description": "Your 1-sentence summary",
      "writeup": "2-3 paragraph investment analysis",
      "thesis_relevance": 8,
      "recency": 7,
      "founding_team": 5,
      "website": "https://company.com if you know it",
      "crunchbase_url": "https://crunchbase.com/organization/company if you know it"
    }
  ],
  "synthesis": "1-2 paragraphs synthesizing the overall landscape and key opportunities"
}`;

async function analyzeCompanies(thesis, companies, searchTerms, progressCallback) {
  if (companies.length === 0) {
    return { analyzed_companies: [], synthesis: 'No companies found to analyze.' };
  }

  // Limit to top 8 companies by fit score to stay within time budget
  const topCompanies = companies.slice(0, 8);
  progressCallback(`Deep analyzing top ${topCompanies.length} companies...`);

  // Prepare company list with all available data
  const companyList = topCompanies.map(c => {
    let info = `- ${c.name}`;
    if (c.description) info += `: ${c.description}`;
    if (c.website) info += ` (${c.website})`;
    if (c.founded_year) info += ` [Founded: ${c.founded_year}]`;
    if (c.funding_total) info += ` [Raised: $${(c.funding_total / 1000000).toFixed(1)}M]`;
    if (c.fit_reason) info += ` [Pre-filter note: ${c.fit_reason}]`;
    return info;
  }).join('\n');

  const prompt = `${ANALYSIS_PROMPT}

INVESTMENT THESIS: "${thesis}"

THESIS CONTEXT:
${searchTerms.thesis_summary}

COMPANIES TO ANALYZE (pre-filtered for fit, from real sources):
${companyList}

Provide deep analysis for each. Focus on WHY they fit (or don't) the thesis.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 5000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse analysis response');
  
  return JSON.parse(jsonMatch[0]);
}

/**
 * Main research flow - SEARCH FIRST (using adjacent themes), FILTER BY FIT, THEN ANALYZE
 * Adjacent themes (2nd/3rd order effects) are generated upfront and used in discovery
 */
export async function* runResearch(thesis) {
  yield { type: 'progress', message: 'Analyzing thesis and generating search terms...' };
  
  try {
    // Step 1: Generate search terms
    const searchTerms = await generateSearchTerms(thesis);
    yield { type: 'progress', message: `Generated ${searchTerms.search_queries.length} search queries` };
    
    // Step 2: AGGRESSIVE search across all sources
    const realCompanies = await findRealCompanies(searchTerms, (msg) => {
      // Progress callback - we'll emit events
    });
    yield { type: 'progress', message: `Found ${realCompanies.length} companies from Crunchbase + Web` };
    
    if (realCompanies.length === 0) {
      yield { type: 'progress', message: 'No companies found. Check API keys (CRUNCHBASE_API_KEY, BRAVE_API_KEY)' };
      yield {
        type: 'complete',
        data: {
          companies: [],
          public_comps: searchTerms.public_comps || [],
          summary: 'No companies found. Please ensure CRUNCHBASE_API_KEY and BRAVE_API_KEY are set.',
        }
      };
      return;
    }

    // Step 3: QUICK FIT FILTER - score for direct fit AND 2nd/3rd order relevance
    const filteredCompanies = await quickFitFilter(thesis, realCompanies, searchTerms, (msg) => {});
    yield { type: 'progress', message: `${filteredCompanies.length} companies passed fit filter (direct + adjacent)` };

    if (filteredCompanies.length === 0) {
      yield { type: 'progress', message: 'No companies passed the fit filter for this thesis.' };
      yield {
        type: 'complete',
        data: {
          companies: [],
          public_comps: searchTerms.public_comps || [],
          summary: `Searched ${realCompanies.length} companies but none were a strong fit for: ${thesis}`,
        }
      };
      return;
    }

    // Step 4: DEEP ANALYSIS - only for filtered companies
    yield { type: 'progress', message: `Deep analyzing top ${Math.min(filteredCompanies.length, 8)} companies...` };
    const analysis = await analyzeCompanies(thesis, filteredCompanies, searchTerms, (msg) => {});
    
    // Step 5: Merge real company data with analysis
    const enrichedCompanies = [];
    for (const analyzed of analysis.analyzed_companies || []) {
      // Find matching real company
      const realCompany = filteredCompanies.find(
        c => c.name.toLowerCase() === analyzed.name.toLowerCase()
      );
      
      if (realCompany) {
        const merged = {
          name: analyzed.name,
          description: analyzed.description || realCompany.description,
          writeup: analyzed.writeup || '',
          thesis_relevance: analyzed.thesis_relevance || 5,
          recency: analyzed.recency || 5,
          founding_team: analyzed.founding_team || 5,
          // Preserve real data
          website: realCompany.website || analyzed.website,
          x_url: realCompany.x_url || null,
          crunchbase_url: realCompany.crunchbase_verified 
            ? `https://www.crunchbase.com/organization/${realCompany.name.toLowerCase().replace(/\s+/g, '-')}`
            : (analyzed.crunchbase_url || null),
          founded_year: realCompany.founded_year || null,
          crunchbase_verified: realCompany.crunchbase_verified || false,
          funding_total_usd: realCompany.funding_total || null,
          source: realCompany.source,
          fit_score: realCompany.fit_score,
          fit_type: realCompany.fit_type || 'direct',
          discovered_via_theme: realCompany.discovered_via_theme || null,
          // NEW FIELDS: Sources and funding stage
          funding_stage: realCompany.funding_stage || 'unknown',
          last_funding_type: realCompany.last_funding_type || null,
          sources: realCompany.sources || [],
        };
        
        enrichedCompanies.push(merged);
        yield { type: 'company', data: merged };
      }
    }

    // Sort by total score
    enrichedCompanies.sort((a, b) => {
      const scoreA = (a.thesis_relevance || 0) + (a.recency || 0) + (a.founding_team || 0);
      const scoreB = (b.thesis_relevance || 0) + (b.recency || 0) + (b.founding_team || 0);
      return scoreB - scoreA;
    });

    // Adjacent themes are from initial analysis - they were used in discovery/filtering
    // Normalize format: ensure we return objects with theme, order, rationale
    const adjacentThemes = (searchTerms.adjacent_themes || []).map(t => {
      if (typeof t === 'string') {
        return { theme: t, order: '2nd', rationale: 'Related to thesis' };
      }
      return t;
    });

    // Count how many companies came from each discovery source
    const directCount = enrichedCompanies.filter(c => c.discovery_source === 'primary_thesis' || !c.discovery_source).length;
    const adjacentCount = enrichedCompanies.filter(c => c.discovery_source === 'adjacent_theme').length;
    
    yield { type: 'progress', message: `Found ${directCount} direct + ${adjacentCount} via 2nd/3rd order themes` };

    // Step 6: Search for THESIS-VALIDATING sources (patents, research, newsletters)
    yield { type: 'progress', message: 'Searching for thesis-validating sources...' };
    let thesisSources = [];
    if (isWebSearchAvailable()) {
      thesisSources = await searchThesisSources(thesis, searchTerms.primary_keywords, 8);
      yield { type: 'progress', message: `Found ${thesisSources.length} validating sources (patents, research, articles)` };
    }

    yield {
      type: 'complete',
      data: {
        companies: enrichedCompanies,
        public_comps: searchTerms.public_comps || [],
        summary: analysis.synthesis || searchTerms.thesis_summary,
        adjacent_themes: adjacentThemes,
        discovery_stats: {
          direct_thesis: directCount,
          adjacent_themes: adjacentCount,
        },
        thesis_sources: thesisSources, // NEW: Validating sources for the thesis itself
      }
    };

  } catch (error) {
    console.error('Research error:', error);
    yield { type: 'error', message: error.message };
    throw error;
  }
}
