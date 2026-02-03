import { getDb } from '../lib/db.js';

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
  
  try {
    const sql = getDb();
    const { page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    // Get theses with company count
    const theses = await sql`
      SELECT 
        t.*,
        COUNT(c.id)::int as company_count
      FROM theses t
      LEFT JOIN companies c ON c.thesis_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT ${parseInt(limit)}
      OFFSET ${offset}
    `;
    
    // Get total count
    const countResult = await sql`SELECT COUNT(*)::int as total FROM theses`;
    const total = countResult[0]?.total || 0;
    
    res.status(200).json({
      theses,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Theses list error:', error);
    res.status(500).json({ error: error.message });
  }
}
