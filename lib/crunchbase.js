// Crunchbase API integration
// API Docs: https://data.crunchbase.com/docs

const CRUNCHBASE_API_KEY = process.env.CRUNCHBASE_API_KEY;
const BASE_URL = 'https://api.crunchbase.com/api/v4';

/**
 * Search for organizations matching a query
 * Uses multiple search strategies to find relevant companies
 */
export async function searchOrganizations(query, limit = 10) {
  if (!CRUNCHBASE_API_KEY) {
    console.warn('CRUNCHBASE_API_KEY not set, skipping Crunchbase enrichment');
    return [];
  }

  console.log(`[Crunchbase] Searching for: "${query}" with key: ${CRUNCHBASE_API_KEY.slice(0, 8)}...`);

  try {
    // Build query predicates
    const queryPredicates = [
      {
        type: 'predicate',
        field_id: 'facet_ids',
        operator_id: 'includes',
        values: ['company']
      },
      // Focus on recent companies (seed stage)
      {
        type: 'predicate',
        field_id: 'founded_on',
        operator_id: 'gte',
        values: ['2019-01-01']
      },
      // Filter out defunct/closed companies
      {
        type: 'predicate',
        field_id: 'operating_status',
        operator_id: 'includes',
        values: ['active']
      }
    ];

    // Add description search with multiple keywords for better coverage
    const keywords = query.split(' ').filter(k => k.length > 2).slice(0, 2);
    if (keywords.length > 0) {
      queryPredicates.push({
        type: 'predicate',
        field_id: 'short_description',
        operator_id: 'contains',
        values: [keywords[0]]
      });
    }

    const response = await fetch(`${BASE_URL}/searches/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-cb-user-key': CRUNCHBASE_API_KEY,
      },
      body: JSON.stringify({
        field_ids: [
          'identifier',
          'short_description',
          'founded_on',
          'website_url',
          'funding_total',
          'last_funding_type',
          'last_funding_at',
          'num_employees_enum',
          'categories',
          'category_groups',
          'operating_status'
        ],
        query: queryPredicates,
        order: [
          { field_id: 'rank_org', sort: 'asc' }
        ],
        limit: Math.min(limit, 25),  // Request more to have buffer
      }),
    });

    console.log(`[Crunchbase] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Crunchbase] Search error (${response.status}):`, errorText);
      return [];
    }

    const data = await response.json();
    console.log(`[Crunchbase] Found ${data.entities?.length || 0} results for "${query}"`);
    return data.entities || [];
  } catch (error) {
    console.error('[Crunchbase] Search failed:', error.message);
    return [];
  }
}

/**
 * Search by category/industry group
 */
export async function searchByCategory(categoryGroup, limit = 10) {
  if (!CRUNCHBASE_API_KEY) return [];

  console.log(`[Crunchbase] Searching category: "${categoryGroup}"`);

  try {
    const response = await fetch(`${BASE_URL}/searches/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-cb-user-key': CRUNCHBASE_API_KEY,
      },
      body: JSON.stringify({
        field_ids: [
          'identifier',
          'short_description',
          'founded_on',
          'website_url',
          'funding_total',
          'last_funding_type',
          'categories'
        ],
        query: [
          {
            type: 'predicate',
            field_id: 'facet_ids',
            operator_id: 'includes',
            values: ['company']
          },
          {
            type: 'predicate',
            field_id: 'category_groups',
            operator_id: 'includes',
            values: [categoryGroup]
          },
          {
            type: 'predicate',
            field_id: 'founded_on',
            operator_id: 'gte',
            values: ['2020-01-01']
          },
          {
            type: 'predicate',
            field_id: 'last_funding_type',
            operator_id: 'includes',
            values: ['seed', 'pre_seed', 'angel', 'series_a']
          },
          // Filter out defunct/closed companies
          {
            type: 'predicate',
            field_id: 'operating_status',
            operator_id: 'includes',
            values: ['active']
          }
        ],
        order: [
          { field_id: 'funding_total', sort: 'desc' }
        ],
        limit,
      }),
    });

    if (!response.ok) return [];

    const data = await response.json();
    console.log(`[Crunchbase] Found ${data.entities?.length || 0} companies in category "${categoryGroup}"`);
    return data.entities || [];
  } catch (error) {
    console.error('[Crunchbase] Category search failed:', error.message);
    return [];
  }
}

/**
 * Fetch full details for multiple organizations by permalink
 */
async function fetchOrganizationDetails(permalinks) {
  const results = [];
  
  for (const permalink of permalinks.slice(0, 10)) {
    try {
      const response = await fetch(
        `${BASE_URL}/entities/organizations/${permalink}?field_ids=identifier,short_description,founded_on,website_url,linkedin_url,twitter_url,num_employees_enum,funding_total,last_funding_type,last_funding_at,categories`,
        {
          headers: {
            'X-cb-user-key': CRUNCHBASE_API_KEY,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        results.push({ properties: data.properties });
      }
    } catch (e) {
      console.error(`Failed to fetch ${permalink}:`, e.message);
    }
  }
  
  return results;
}

/**
 * Get detailed organization info by permalink
 */
export async function getOrganization(permalink) {
  if (!CRUNCHBASE_API_KEY) {
    return null;
  }

  try {
    const response = await fetch(
      `${BASE_URL}/entities/organizations/${permalink}?field_ids=identifier,short_description,founded_on,website_url,linkedin_url,twitter_url,num_employees_enum,funding_total,last_funding_type,last_funding_at,founder_identifiers,categories`,
      {
        headers: {
          'X-cb-user-key': CRUNCHBASE_API_KEY,
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.properties || null;
  } catch (error) {
    console.error('Crunchbase get org failed:', error.message);
    return null;
  }
}

/**
 * Enrich a company object with Crunchbase data
 * @param {Object} company - Company object from Claude
 * @returns {Object} - Enriched company object
 */
export async function enrichCompany(company) {
  if (!CRUNCHBASE_API_KEY) {
    return company;
  }

  try {
    // Search for the company
    const results = await searchOrganizations(company.name, 3);
    
    if (!results.length) {
      console.log(`No Crunchbase match for: ${company.name}`);
      return { ...company, crunchbase_verified: false };
    }

    // Find best match - must match name AND have relevant description
    // This prevents picking "Cambio (biotech)" when we searched for "Cambio (real estate)"
    const companyNameLower = company.name.toLowerCase();
    const contextKeywords = (company.search_context || company.description || '').toLowerCase();
    
    const match = results.find(r => {
      const cbName = (r.properties?.identifier?.value || '').toLowerCase();
      const cbDesc = (r.properties?.short_description || '').toLowerCase();
      
      // Name must match
      const nameMatches = cbName === companyNameLower || cbName.includes(companyNameLower);
      if (!nameMatches) return false;
      
      // If we have context, description should have SOME relevance
      // Skip this check if no context available
      if (contextKeywords && contextKeywords.length > 10) {
        const contextWords = contextKeywords.split(/\s+/).filter(w => w.length > 4);
        const hasRelevance = contextWords.some(word => cbDesc.includes(word));
        // If description has ZERO overlap with context, likely wrong company
        if (contextWords.length > 3 && !hasRelevance) {
          console.log(`[Crunchbase] Skipping ${cbName} - description doesn't match context`);
          return false;
        }
      }
      
      return true;
    });
    
    // If no contextually-relevant match, don't enrich (better to have no data than wrong data)
    if (!match) {
      console.log(`[Crunchbase] No contextually-relevant match for: ${company.name}`);
      return { ...company, crunchbase_verified: false };
    }

    const props = match.properties || {};
    const identifier = props.identifier?.value || props.identifier?.permalink;

    // Build Crunchbase URL
    const crunchbaseUrl = identifier 
      ? `https://www.crunchbase.com/organization/${identifier}`
      : company.crunchbase_url;

    // Extract founded year
    let foundedYear = company.founded_year;
    if (props.founded_on?.value) {
      foundedYear = parseInt(props.founded_on.value.split('-')[0], 10);
    }

    // Calculate recency score based on real founding date
    let recencyScore = company.recency;
    if (foundedYear) {
      const yearsOld = new Date().getFullYear() - foundedYear;
      if (yearsOld <= 1) recencyScore = 10;
      else if (yearsOld <= 2) recencyScore = 8;
      else if (yearsOld <= 3) recencyScore = 6;
      else if (yearsOld <= 5) recencyScore = 4;
      else recencyScore = 2;
    }

    // Extract funding info for description enhancement
    const fundingTotal = props.funding_total?.value_usd;
    const lastFundingType = props.last_funding_type;

    return {
      ...company,
      website: props.website_url?.value || company.website,
      x_url: props.twitter_url?.value ? `https://x.com/${props.twitter_url.value.replace('@', '')}` : company.x_url,
      crunchbase_url: crunchbaseUrl,
      founded_year: foundedYear,
      recency: recencyScore,
      funding_total_usd: fundingTotal,
      last_funding_type: lastFundingType,
      crunchbase_verified: true,
      // Recalculate total score
      total_score: company.thesis_relevance + recencyScore + company.founding_team,
    };
  } catch (error) {
    console.error(`Failed to enrich ${company.name}:`, error.message);
    return { ...company, crunchbase_verified: false };
  }
}

/**
 * Check if Crunchbase API is available
 */
export function isCrunchbaseAvailable() {
  return !!CRUNCHBASE_API_KEY;
}
