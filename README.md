# CoStage Designer — Platform

AI-powered virtual staging for real estate. Co-pilot staging with full manual
control over furniture selection and placement, plus multi-angle geometric
consistency across every listing photo.

## The pipeline

```
  Room photos                    Furniture sources
       │                               │
       ▼                               ▼
  ┌──────────┐                  ┌──────────────┐
  │ image-   │                  │ Library      │  scrape retailer →
  │ blaster  │ camera poses     │ Builder      │  clean plate → multi-angle →
  │ (World   │ + floor plan     │ (4-stage     │  Hunyuan 3D → preview
  │  Labs)   │                  │  pipeline)   │
  └────┬─────┘                  └──────┬───────┘
       │                               │
       │  spatialParser.js             │  costage-library.json (GLBs)
       ▼                               ▼
  ┌─────────────────────────────────────────┐
  │  Floor Plan Editor                       │  drag furniture onto 2D plan
  │  (place furniture, export placements)    │  → exports world coords + per-camera UVs
  └────────────────────┬─────────────────────┘
                       │  costage-placements.json
                       ▼
  ┌─────────────────────────────────────────┐
  │  Compositor (Three.js)                   │  projects GLBs into each photo at
  │  (render staged photos, all angles)      │  correct perspective via camera poses
  └─────────────────────────────────────────┘
```

## Files

### Frontend apps (open directly in a browser)

| File | What it does |
|------|--------------|
| `libraryBuilder.html` | Paste a single product page link → fetch it, run it through the 4-stage pipeline, and save the GLB to your library. Builds up over time, one piece at a time. Routes through `backend/` when running. |
| `floorPlanEditor.html` | Drag furniture onto a 2D floor plan generated from spatial data. Exports `costage-placements.json`. |
| `compositor.html` | Three.js compositor — projects GLB furniture into room photos using camera poses. |

### JS modules (imported by the apps / your own code)

| File | What it does |
|------|--------------|
| `spatialParser.js` | Parses image-blaster / COLMAP output → floor polygon, camera poses, room dims. Includes `projectToPhoto()` — the core floor-plan-to-pixel projection. |
| `assetPipeline.js` | The 4-stage asset pipeline: nano-banana clean plate → gpt-image-2 multi-angle → Hunyuan 3D → nano-banana preview. |

### Backend (`backend/`)

| File | What it does |
|------|--------------|
| `server.js` | Express + Puppeteer scraper. Renders JS-heavy furniture sites, extracts products for free via JSON-LD parsing + heuristic DOM scraping (no API key needed). |
| `package.json` | Backend dependencies. |
| `.env.example` | Copy to `.env`. No keys required for scraping — just an optional `PORT`. |

## Quick start

### 1. Backend (for live retailer scraping)

```bash
cd backend
npm install
cp .env.example .env       # no keys needed — extraction is free and rule-based
npm start                  # → http://localhost:3001
```

### 2. Frontend

Just open any of the `.html` files in your browser. They work standalone in
mock mode; the library builder upgrades to live scraping automatically when the
backend is running.

## End-to-end workflow

1. **Build your library** — open `libraryBuilder.html`, find a piece you like on
   a retailer's site, paste its product page link, fetch it, and build the 3D
   asset. It's saved to your library automatically — repeat over time to grow
   it, then export `costage-library.json` whenever you need a portable copy.
2. **Capture the room** — run room photos through image-blaster (World Labs) to
   get camera poses. (Parsed by `spatialParser.js`.)
3. **Stage it** — open `floorPlanEditor.html`, drag furniture from your library
   onto the floor plan. Export `costage-placements.json`.
4. **Render** — open `compositor.html`, load the photos + placements JSON, hit
   "Render all". Download the staged photos.

## API keys needed

- **nano-banana** — clean plate + preview render (library builder sidebar)
- **OpenAI** — gpt-image-2 multi-angle generation (library builder sidebar)
- **FAL** — Hunyuan 3D reconstruction (library builder sidebar)
- **World Labs** — room reconstruction / camera poses (image-blaster, external)

## A note on scraping

Scraping retailer sites can run into terms-of-service limits and bot detection.
Fine for a personal tool pulling a few products; if CoStage goes commercial,
check each retailer's ToS or look for an official product API / affiliate feed.
