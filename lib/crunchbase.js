// Crunchbase API integration
// API Docs: https://data.crunchbase.com/docs

const CRUNCHBASE_API_KEY = process.env.CRUNCHBASE_API_KEY;
const BASE_URL = 'https://api.crunchbase.com/api/v4';

/**
 * Search for organizations matching a query
 */
export async function searchOrganizations(query, limit = 10) {
  if (!CRUNCHBASE_API_KEY) {
    console.warn('CRUNCHBASE_API_KEY not set, skipping Crunchbase enrichment');
    return [];
  }

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
          'linkedin_url',
          'twitter_url',
          'num_employees_enum',
          'funding_total',
          'last_funding_type',
          'last_funding_at',
          'founder_identifiers'
        ],
        query: [
          {
            type: 'predicate',
            field_id: 'identifier',
            operator_id: 'contains',
            values: [query]
          }
        ],
        limit,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Crunchbase search error:', error);
      return [];
    }

    const data = await response.json();
    return data.entities || [];
  } catch (error) {
    console.error('Crunchbase search failed:', error.message);
    return [];
  }
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

    // Find best match (simple name comparison)
    const match = results.find(r => 
      r.properties?.identifier?.value?.toLowerCase() === company.name.toLowerCase() ||
      r.properties?.identifier?.value?.toLowerCase().includes(company.name.toLowerCase())
    ) || results[0];

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
