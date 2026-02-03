import { initDb, getDb } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { errors } = await initDb();
    
    // Also check what columns exist
    const sql = getDb();
    const columns = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'companies'
      ORDER BY ordinal_position
    `;
    
    res.status(200).json({ 
      success: true, 
      message: 'Database initialized',
      migration_errors: errors.length > 0 ? errors : null,
      companies_columns: columns.map(c => c.column_name)
    });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ error: error.message });
  }
}
