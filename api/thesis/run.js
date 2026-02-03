import { getDb } from '../../lib/db.js';
import { runResearch } from '../../lib/research.js';

export const config = {
  maxDuration: 60, // Allow up to 60 seconds for research
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { thesis } = req.body;
  
  if (!thesis || typeof thesis !== 'string' || thesis.trim().length === 0) {
    return res.status(400).json({ error: 'Thesis is required' });
  }
  
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendEvent = (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  try {
    const sql = getDb();
    
    // Create thesis record
    const [newThesis] = await sql`
      INSERT INTO theses (thesis, status)
      VALUES (${thesis.trim()}, 'running')
      RETURNING *
    `;
    
    sendEvent('start', { thesis_id: newThesis.id, thesis: thesis.trim() });
    
    const companies = [];
    
    // Run research with streaming
    for await (const event of runResearch(thesis.trim())) {
      if (event.type === 'progress') {
        sendEvent('progress', { message: event.message });
      } else if (event.type === 'company') {
        // Save company to database
        const [savedCompany] = await sql`
          INSERT INTO companies (
            thesis_id, name, description, writeup,
            thesis_relevance, recency, founding_team,
            website, x_url, crunchbase_url, founded_year
          )
          VALUES (
            ${newThesis.id},
            ${event.data.name},
            ${event.data.description || ''},
            ${event.data.writeup || ''},
            ${event.data.thesis_relevance || 5},
            ${event.data.recency || 5},
            ${event.data.founding_team || 5},
            ${event.data.website || null},
            ${event.data.x_url || null},
            ${event.data.crunchbase_url || null},
            ${event.data.founded_year || null}
          )
          RETURNING *
        `;
        companies.push(savedCompany);
        sendEvent('company', savedCompany);
      } else if (event.type === 'complete') {
        // Update thesis with summary and public comps
        await sql`
          UPDATE theses SET
            status = 'complete',
            completed_at = NOW(),
            summary = ${event.data.summary || ''},
            public_comps = ${event.data.public_comps || []}
          WHERE id = ${newThesis.id}
        `;
        
        sendEvent('complete', {
          thesis_id: newThesis.id,
          summary: event.data.summary,
          public_comps: event.data.public_comps,
          company_count: companies.length
        });
      } else if (event.type === 'error') {
        sendEvent('error', { message: event.message });
      }
    }
    
  } catch (error) {
    console.error('Thesis run error:', error);
    sendEvent('error', { message: error.message });
    
    // Try to update thesis status to failed
    try {
      const sql = getDb();
      await sql`UPDATE theses SET status = 'failed' WHERE thesis = ${thesis.trim()} AND status = 'running'`;
    } catch (e) {
      // Ignore
    }
  } finally {
    res.end();
  }
}
