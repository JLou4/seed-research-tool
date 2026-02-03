import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Simple research - just ask Claude to think hard about 10 real companies
 * No complex queue system, no API dependencies
 */
const RESEARCH_PROMPT = `You are a seed-stage investment analyst with deep knowledge of the startup ecosystem.

TASK: Find 10 REAL startups that match this investment thesis.

CRITICAL RULES:
1. ONLY include companies you are CONFIDENT actually exist
2. If you're not sure a company is real, DO NOT include it
3. Better to have 5 verified companies than 10 with guesses
4. Include their real website URLs - if you can't recall the URL, don't include the company
5. Focus on companies founded 2020-2025 (seed/early stage)

For each company provide:
- name: Exact company name
- description: 1-2 sentence summary of what they do
- website: Their actual website URL (must be real)
- founded_year: Year founded (if known)
- writeup: 2-3 paragraphs explaining WHY this company fits the thesis
- thesis_relevance: 1-10 score for thesis fit
- recency: 1-10 score (10 = founded 2024-2025, 5 = 2021-2022, 1 = older)
- founding_team: 1-10 score based on what you know (5 if unknown)

Think carefully about each company. Quality > quantity.

Return JSON:
{
  "companies": [...],
  "public_comps": ["TICKER1", "TICKER2"],  // 3-5 related public companies
  "summary": "1-2 paragraphs summarizing the thesis and landscape"
}`;

export async function* runResearchSimple(thesis) {
  yield { type: 'progress', message: 'Analyzing thesis (thinking deeply about real companies)...' };
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      thinking: {
        type: 'enabled',
        budget_tokens: 4000,  // Balanced - enough to think but fit in 60s timeout
      },
      messages: [{
        role: 'user',
        content: `${RESEARCH_PROMPT}\n\nINVESTMENT THESIS: "${thesis}"\n\nTake your time. Think through which companies you actually know exist and fit this thesis. Only include ones you're confident about.`
      }],
    });

    // Extract the text response (after thinking)
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        text = block.text;
        break;
      }
    }

    yield { type: 'progress', message: 'Processing results...' };

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse response');
    }
    
    const result = JSON.parse(jsonMatch[0]);
    const companies = result.companies || [];

    // Stream each company
    for (const company of companies) {
      yield { type: 'company', data: company };
    }

    yield {
      type: 'complete',
      data: {
        companies,
        public_comps: result.public_comps || [],
        summary: result.summary || '',
      }
    };

  } catch (error) {
    console.error('Research error:', error);
    yield { type: 'error', message: error.message };
    throw error;
  }
}
