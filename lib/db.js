import { neon } from '@neondatabase/serverless';

let sql = null;

export function getDb() {
  if (!sql) {
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS theses (
  id SERIAL PRIMARY KEY,
  thesis TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  summary TEXT,
  public_comps TEXT[],
  adjacent_themes JSONB,
  discovery_stats JSONB,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  thesis_id INTEGER REFERENCES theses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  writeup TEXT,
  thesis_relevance INTEGER,
  recency INTEGER,
  founding_team INTEGER,
  total_score INTEGER,
  website TEXT,
  x_url TEXT,
  crunchbase_url TEXT,
  founded_year INTEGER,
  fit_type VARCHAR(20),
  discovered_via_theme VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS findings (
  id SERIAL PRIMARY KEY,
  thesis_id INTEGER REFERENCES theses(id) ON DELETE CASCADE,
  finding TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_thesis ON companies(thesis_id);
CREATE INDEX IF NOT EXISTS idx_findings_thesis ON findings(thesis_id);
CREATE INDEX IF NOT EXISTS idx_theses_created ON theses(created_at DESC);
`;

export async function initDb() {
  const sql = getDb();
  const errors = [];
  
  // Run schema
  await sql.unsafe(SCHEMA);
  
  // Migration: Add columns if they don't exist (with LOGGING)
  try {
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS fit_type VARCHAR(20)`;
    console.log('Migration: fit_type column OK');
  } catch (e) {
    console.error('Migration ERROR (fit_type):', e.message);
    errors.push(`fit_type: ${e.message}`);
  }
  
  try {
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS discovered_via_theme VARCHAR(255)`;
    console.log('Migration: discovered_via_theme column OK');
  } catch (e) {
    console.error('Migration ERROR (discovered_via_theme):', e.message);
    errors.push(`discovered_via_theme: ${e.message}`);
  }
  
  try {
    await sql`ALTER TABLE theses ADD COLUMN IF NOT EXISTS adjacent_themes JSONB`;
    console.log('Migration: adjacent_themes column OK');
  } catch (e) {
    console.error('Migration ERROR (adjacent_themes):', e.message);
    errors.push(`adjacent_themes: ${e.message}`);
  }
  
  try {
    await sql`ALTER TABLE theses ADD COLUMN IF NOT EXISTS discovery_stats JSONB`;
    console.log('Migration: discovery_stats column OK');
  } catch (e) {
    console.error('Migration ERROR (discovery_stats):', e.message);
    errors.push(`discovery_stats: ${e.message}`);
  }
  
  return { errors };
}
