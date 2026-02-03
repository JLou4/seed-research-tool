import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const RESEARCH_PROMPT = `You are a seed-stage investment research analyst. Your job is to find early-stage companies that match a given investment thesis.

For each company you identify, provide:
1. **Company Name** and what they do (1-2 sentences)
2. **Thesis Alignment** (3-4 paragraphs): How does this company align with the thesis? Focus on second and third-order effects, not just surface-level descriptions. Think like an investor.
3. **Scores** (1-10 each):
   - Thesis Relevance: How well does this match the investment thesis?
   - Recency: How recently founded/announced? (10 = last 6 months, 5 = 1-2 years, 1 = 3+ years)
   - Founding Team: Based on available info, how strong is the team?
4. **Links**: Website, X/Twitter handle, Crunchbase URL (if known)
5. **Founded Year** (if known)

Also identify 2-3 public companies that are comparable or adjacent to monitor.

Be specific. Use real companies. If you're not confident about a company, say so.

Format your response as JSON with this structure:
{
  "companies": [
    {
      "name": "Company Name",
      "description": "What they do in 1-2 sentences",
      "writeup": "3-4 paragraph thesis analysis",
      "thesis_relevance": 8,
      "recency": 7,
      "founding_team": 6,
      "website": "https://...",
      "x_url": "https://x.com/...",
      "crunchbase_url": "https://crunchbase.com/...",
      "founded_year": 2023
    }
  ],
  "public_comps": ["NVDA", "TSLA", "AMZN"],
  "summary": "Brief summary of the thesis landscape and key insights"
}`;

export async function* runResearch(thesis) {
  yield { type: 'progress', message: 'Starting thesis research...' };
  
  const fullPrompt = `${RESEARCH_PROMPT}

INVESTMENT THESIS: "${thesis}"

Find 5-8 relevant early-stage companies. Focus on pre-seed, seed, and Series A companies. Prioritize companies that are less obvious but highly aligned with the thesis.`;

  yield { type: 'progress', message: 'Querying Claude for company analysis...' };
  
  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: fullPrompt }],
    });

    let fullResponse = '';
    
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        // Send partial updates every ~500 chars
        if (fullResponse.length % 500 < 50) {
          yield { type: 'progress', message: `Researching... (${Math.floor(fullResponse.length / 100) * 100}+ chars)` };
        }
      }
    }

    yield { type: 'progress', message: 'Parsing research results...' };
    
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = fullResponse;
    const jsonMatch = fullResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }
    
    const result = JSON.parse(jsonStr.trim());
    
    // Yield each company as it's processed
    for (const company of result.companies || []) {
      yield { type: 'company', data: company };
    }
    
    yield { 
      type: 'complete', 
      data: {
        companies: result.companies || [],
        public_comps: result.public_comps || [],
        summary: result.summary || ''
      }
    };
    
  } catch (error) {
    yield { type: 'error', message: error.message };
    throw error;
  }
}
