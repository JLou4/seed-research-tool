# Seed Syndicate API

Backend API for the Seed Syndicate Automator - a tool for co-managing seed investment pipelines.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/setup` | Initialize database tables |
| GET | `/api/theses` | List all theses (paginated) |
| GET | `/api/thesis/:id` | Get thesis detail with companies |
| POST | `/api/thesis/run` | Run new thesis research (SSE stream) |

## SSE Events (POST /api/thesis/run)

The `/api/thesis/run` endpoint streams Server-Sent Events:

- `start` - Research started, includes `thesis_id`
- `progress` - Status updates during research
- `company` - Individual company data as discovered
- `complete` - Final summary + public comps
- `error` - Error occurred

## Setup

1. Create a Neon Postgres database
2. Copy `.env.example` to `.env` and fill in values
3. Deploy to Vercel or run locally

```bash
# Install dependencies
npm install

# Run locally
vercel dev

# Deploy
vercel --prod
```

## Environment Variables

- `DATABASE_URL` - Neon Postgres connection string
- `ANTHROPIC_API_KEY` - Claude API key for research

## Database Schema

See `lib/db.js` for full schema. Main tables:

- `theses` - Investment thesis records
- `companies` - Discovered companies with scores
- `findings` - Research findings/insights

## Frontend Integration

Connect via EventSource for SSE:

```javascript
const eventSource = new EventSource('/api/thesis/run');

eventSource.addEventListener('company', (e) => {
  const company = JSON.parse(e.data);
  // Add to UI
});

eventSource.addEventListener('complete', (e) => {
  const result = JSON.parse(e.data);
  eventSource.close();
});
```

For POST requests with SSE, use fetch with streaming:

```javascript
const response = await fetch('/api/thesis/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ thesis: 'Your investment thesis' })
});

const reader = response.body.getReader();
// ... process SSE stream
```
