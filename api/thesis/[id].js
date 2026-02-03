import { getDb } from '../../lib/db.js';

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
  
  const { id } = req.query;
  
  try {
    const sql = getDb();
    
    // Get thesis
    const theses = await sql`
      SELECT * FROM theses WHERE id = ${parseInt(id)}
    `;
    
    if (theses.length === 0) {
      return res.status(404).json({ error: 'Thesis not found' });
    }
    
    const thesis = theses[0];
    
    // Get companies for this thesis
    const companies = await sql`
      SELECT * FROM companies 
      WHERE thesis_id = ${parseInt(id)}
      ORDER BY total_score DESC
    `;
    
    // Get findings
    const findings = await sql`
      SELECT * FROM findings 
      WHERE thesis_id = ${parseInt(id)}
      ORDER BY created_at ASC
    `;
    
    res.status(200).json({
      ...thesis,
      companies,
      findings
    });
  } catch (error) {
    console.error('Thesis detail error:', error);
    res.status(500).json({ error: error.message });
  }
}
