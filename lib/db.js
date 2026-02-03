import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

export function getDb() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return neon(DATABASE_URL);
}

// Database schema
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS theses (
  id SERIAL PRIMARY KEY,
  thesis TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  summary TEXT,
  public_comps TEXT[]
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
  total_score INTEGER GENERATED ALWAYS AS (thesis_relevance + recency + founding_team) STORED,
  website TEXT,
  x_url TEXT,
  crunchbase_url TEXT,
  founded_year INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS findings (
  id SERIAL PRIMARY KEY,
  thesis_id INTEGER REFERENCES theses(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_thesis ON companies(thesis_id);
CREATE INDEX IF NOT EXISTS idx_findings_thesis ON findings(thesis_id);
CREATE INDEX IF NOT EXISTS idx_theses_created ON theses(created_at DESC);
`;

export async function initDb() {
  const sql = getDb();
  
  // Create tables one at a time
  await sql`
    CREATE TABLE IF NOT EXISTS theses (
      id SERIAL PRIMARY KEY,
      thesis TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP,
      summary TEXT,
      public_comps TEXT[]
    )
  `;
  
  await sql`
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
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  
  await sql`
    CREATE TABLE IF NOT EXISTS findings (
      id SERIAL PRIMARY KEY,
      thesis_id INTEGER REFERENCES theses(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_thesis ON companies(thesis_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_findings_thesis ON findings(thesis_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_theses_created ON theses(created_at DESC)`;
  
  return { success: true };
}
