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
 * STEP 2: Search for real companies across multiple sources
 */
async function findRealCompanies(searchTerms, progressCallback) {
  const companies = [];
  const seen = new Set();

  // Search Crunchbase if available
  if (isCrunchbaseAvailable()) {
    progressCallback('Searching Crunchbase for startups...');
    
    for (const query of searchTerms.search_queries.slice(0, 4)) {
      try {
        const results = await searchOrganizations(query, 5);
        for (const org of results) {
          const name = org.properties?.identifier?.value;
          if (name && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            companies.push({
              name,
              source: 'crunchbase',
              description: org.properties?.short_description || '',
              website: org.properties?.website_url?.value || '',
              founded_year: org.properties?.founded_on?.value?.split('-')[0],
              funding_total: org.properties?.funding_total?.value_usd,
              last_funding_type: org.properties?.last_funding_type,
              crunchbase_verified: true,
            });
          }
        }
      } catch (e) {
        console.error('Crunchbase search error:', e.message);
      }
    }
    progressCallback(`Found ${companies.length} companies on Crunchbase`);
  }

  // Search web if available (and Crunchbase didn't find enough)
  if (isWebSearchAvailable() && companies.length < 10) {
    progressCallback('Searching web for additional startups...');
    
    const keywords = [...searchTerms.primary_keywords, ...searchTerms.adjacent_themes].join(' ');
    const webResults = await searchStartups(keywords, 10);
    
    for (const result of webResults) {
      // Extract potential company name from title
      const titleParts = result.title.split(/[-–|:]/);
      const potentialName = titleParts[0].trim();
      
      if (potentialName && !seen.has(potentialName.toLowerCase()) && potentialName.length < 50) {
        seen.add(potentialName.toLowerCase());
        companies.push({
          name: potentialName,
          source: 'web',
          description: result.description || '',
          website: result.url,
          crunchbase_verified: false,
        });
      }
    }
    progressCallback(`Found ${companies.length} total companies`);
  }

  return companies;
}

/**
 * STEP 3: Have Claude analyze real companies against the thesis
 */
const ANALYSIS_PROMPT = `You are a seed-stage investment analyst. Analyze these REAL companies against an investment thesis.

CRITICAL: Only analyze the companies provided. Do NOT invent or hallucinate companies. If a company doesn't fit the thesis, give it a low score - don't replace it with a made-up company.

For each company, provide:
1. A 2-3 paragraph investment analysis explaining thesis alignment
2. Scores (1-10 each):
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
      "recommendation": "STRONG" | "MODERATE" | "WEAK" | "NOT_RELEVANT"
    }
  ],
  "synthesis": "1-2 paragraphs synthesizing the overall landscape and key opportunities"
}`;

async function analyzeCompanies(thesis, companies, searchTerms, progressCallback) {
  if (companies.length === 0) {
    return { analyzed_companies: [], synthesis: 'No companies found to analyze.' };
  }

  progressCallback(`Analyzing ${companies.length} companies against thesis...`);

  // Prepare company list for Claude
  const companyList = companies.map(c => 
    `- ${c.name}: ${c.description || 'No description'} ${c.website ? `(${c.website})` : ''} ${c.founded_year ? `Founded: ${c.founded_year}` : ''}`
  ).join('\n');

  const prompt = `${ANALYSIS_PROMPT}

INVESTMENT THESIS: "${thesis}"

THESIS CONTEXT:
${searchTerms.thesis_summary}

REAL COMPANIES TO ANALYZE (from Crunchbase and web search):
${companyList}

Analyze each company. Be honest - if a company doesn't fit well, score it low. Do not add companies that aren't in the list above.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse analysis response');
  
  return JSON.parse(jsonMatch[0]);
}

/**
 * Main research flow - REAL COMPANIES FIRST
 */
export async function* runResearch(thesis) {
  yield { type: 'progress', message: 'Analyzing thesis and generating search terms...' };
  
  try {
    // Step 1: Generate search terms
    const searchTerms = await generateSearchTerms(thesis);
    yield { type: 'progress', message: `Generated ${searchTerms.search_queries.length} search queries` };
    
    // Step 2: Find real companies
    const realCompanies = await findRealCompanies(searchTerms, (msg) => {
      // This is a sync callback, we'll batch progress updates
    });
    yield { type: 'progress', message: `Found ${realCompanies.length} real companies to analyze` };
    
    if (realCompanies.length === 0) {
      yield { type: 'progress', message: 'No companies found. Check API keys (CRUNCHBASE_API_KEY, BRAVE_API_KEY)' };
      yield {
        type: 'complete',
        data: {
          companies: [],
          public_comps: searchTerms.public_comps || [],
          summary: 'No companies found. Please check that CRUNCHBASE_API_KEY is set correctly.',
        }
      };
      return;
    }

    // Step 3: Analyze companies against thesis
    yield { type: 'progress', message: `Analyzing ${realCompanies.length} companies against thesis...` };
    const analysis = await analyzeCompanies(thesis, realCompanies, searchTerms, (msg) => {});
    
    // Step 4: Merge real company data with analysis
    const enrichedCompanies = [];
    for (const analyzed of analysis.analyzed_companies || []) {
      // Find matching real company
      const realCompany = realCompanies.find(
        c => c.name.toLowerCase() === analyzed.name.toLowerCase()
      );
      
      if (realCompany) {
        const merged = {
          ...realCompany,
          ...analyzed,
          // Preserve real data
          website: realCompany.website || analyzed.website,
          founded_year: realCompany.founded_year || analyzed.founded_year,
          crunchbase_verified: realCompany.crunchbase_verified,
          funding_total_usd: realCompany.funding_total,
          source: realCompany.source,
        };
        
        // Only include if somewhat relevant
        if (analyzed.recommendation !== 'NOT_RELEVANT') {
          enrichedCompanies.push(merged);
          yield { type: 'company', data: merged };
        }
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
