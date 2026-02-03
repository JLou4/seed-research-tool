import { getDb } from '../lib/db.js';

export const config = {
  maxDuration: 60, // Allow up to 60 seconds for validation
};

/**
 * Background URL validation endpoint
 * GET /api/validate-urls - Validates company website URLs and updates url_valid field
 * Query params:
 *   - limit: Max companies to validate (default 20)
 *   - thesis_id: Optional - only validate companies from specific thesis
 */
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const thesisId = req.query.thesis_id ? parseInt(req.query.thesis_id) : null;
  
  try {
    const sql = getDb();
    
    // Get companies with websites that haven't been validated yet
    let companies;
    if (thesisId) {
      companies = await sql`
        SELECT id, name, website 
        FROM companies 
        WHERE website IS NOT NULL 
          AND website != '' 
          AND url_valid IS NULL
          AND thesis_id = ${thesisId}
        ORDER BY id DESC
        LIMIT ${limit}
      `;
    } else {
      companies = await sql`
        SELECT id, name, website 
        FROM companies 
        WHERE website IS NOT NULL 
          AND website != '' 
          AND url_valid IS NULL
        ORDER BY id DESC
        LIMIT ${limit}
      `;
    }
    
    if (companies.length === 0) {
      return res.json({
        success: true,
        message: 'No companies need URL validation',
        validated: 0,
        valid: 0,
        invalid: 0,
      });
    }
    
    const results = {
      validated: 0,
      valid: 0,
      invalid: 0,
      details: [],
    };
    
    // Validate each URL with HEAD request (faster than GET)
    for (const company of companies) {
      let isValid = null;
      let error = null;
      
      try {
        // Ensure URL has protocol
        let url = company.website;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
        }
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
        
        const response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SeedSyndicateBot/1.0)',
          },
          redirect: 'follow',
        });
        
        clearTimeout(timeout);
        
        // Consider 2xx and 3xx as valid
        isValid = response.status >= 200 && response.status < 400;
        
        if (!isValid) {
          error = `HTTP ${response.status}`;
        }
      } catch (e) {
        isValid = false;
        error = e.name === 'AbortError' ? 'Timeout' : e.message;
      }
      
      // Update database
      await sql`
        UPDATE companies 
        SET url_valid = ${isValid}
        WHERE id = ${company.id}
      `;
      
      results.validated++;
      if (isValid) {
        results.valid++;
      } else {
        results.invalid++;
      }
      
      results.details.push({
        id: company.id,
        name: company.name,
        website: company.website,
        valid: isValid,
        error: error,
      });
    }
    
    return res.json({
      success: true,
      message: `Validated ${results.validated} company URLs`,
      ...results,
    });
    
  } catch (error) {
    console.error('URL validation error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
