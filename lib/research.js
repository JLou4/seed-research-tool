import Anthropic from '@anthropic-ai/sdk';
import { searchOrganizations, enrichCompany, isCrunchbaseAvailable } from './crunchbase.js';
import { searchStartups, isWebSearchAvailable } from './websearch.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * STEP 1: Analyze thesis and generate search terms
 */
const KEYWORD_PROMPT = `You are an investment analyst. Given an investment thesis, generate search keywords to find relevant early-stage startups.

Think about:
- Direct keywords from the thesis
- Adjacent/related industries
- Enabling technologies
- Second-order effects (what needs to exist for this thesis to succeed?)
- Specific verticals or applications

Return JSON only:
{
  "primary_keywords": ["keyword1", "keyword2"],  // 3-5 most direct keywords
  "adjacent_themes": ["theme1", "theme2"],       // 3-5 related/adjacent areas  
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

  const addCompany = (company) => {
    const key = company.name.toLowerCase().trim();
    if (!seen.has(key) && company.name.length > 1 && company.name.length < 100) {
      seen.add(key);
      companies.push(company);
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
                });
              }
            }
          })
          .catch(e => console.error('Crunchbase query search error:', e.message))
      );
    }
  }

  // BRAVE WEB SEARCHES
  if (isWebSearchAvailable()) {
    progressCallback('Searching web sources...');
    
    const keywords = [...searchTerms.primary_keywords, ...searchTerms.adjacent_themes.slice(0, 2)].join(' ');
    searchPromises.push(
      searchStartups(keywords, 15)
        .then(webResults => {
          for (const result of webResults) {
            // Extract potential company name from title
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
                search_tier: result.tier || 2,
              });
            }
          }
        })
        .catch(e => console.error('Web search error:', e.message))
    );
  }

  // Wait for all searches to complete
  await Promise.all(searchPromises);
  
  progressCallback(`Found ${companies.length} unique companies across all sources`);
  return companies;
}

/**
 * STEP 3: QUICK FIT FILTER - Have Claude score fit WITHOUT full analysis
 * This is the "heavy lifting" to filter before deep analysis
 */
const FIT_FILTER_PROMPT = `You are a seed-stage investment analyst doing a QUICK fit check.

For each company, score how well it fits the thesis (1-10):
- 8-10: Strong fit, directly relevant
- 5-7: Moderate fit, adjacently relevant  
- 1-4: Weak fit, probably not relevant

Be FAST and HARSH. Only high scores for companies that clearly fit.

Return JSON only:
{
  "scores": [
    {"name": "Company Name", "fit_score": 8, "reason": "1 sentence why"}
  ]
}`;

async function quickFitFilter(thesis, companies, progressCallback) {
  if (companies.length === 0) return [];
  
  progressCallback(`Quick-scoring ${companies.length} companies for thesis fit...`);

  // Prepare compact company list
  const companyList = companies.map(c => 
    `- ${c.name}: ${(c.description || '').slice(0, 100)}`
  ).join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `${FIT_FILTER_PROMPT}\n\nTHESIS: "${thesis}"\n\nCOMPANIES:\n${companyList}`
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
    scoreMap.set(score.name.toLowerCase(), { fit_score: score.fit_score, reason: score.reason });
  }

  // Filter and annotate companies
  const filtered = companies
    .map(c => {
      const scoreData = scoreMap.get(c.name.toLowerCase());
      return {
        ...c,
        fit_score: scoreData?.fit_score || 5,
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
 * Main research flow - SEARCH FIRST, FILTER BY FIT, THEN ANALYZE
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

    // Step 3: QUICK FIT FILTER - heavy lifting BEFORE deep analysis
    const filteredCompanies = await quickFitFilter(thesis, realCompanies, (msg) => {});
    yield { type: 'progress', message: `${filteredCompanies.length} companies passed fit filter` };

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

    yield {
      type: 'complete',
      data: {
        companies: enrichedCompanies,
        public_comps: searchTerms.public_comps || [],
        summary: analysis.synthesis || searchTerms.thesis_summary,
      }
    };

  } catch (error) {
    console.error('Research error:', error);
    yield { type: 'error', message: error.message };
    throw error;
  }
}
