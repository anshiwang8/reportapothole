This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Setup

Copy `.env.example` to `.env.local` and fill in real values for these four variables:

- `NEXT_PUBLIC_SUPABASE_URL` — your Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase's public/publishable key. Safe to expose to the browser; used for read-only queries and subject to Row Level Security.
- `SUPABASE_SECRET_KEY` — Supabase's secret key. **Server-only, never prefix with `NEXT_PUBLIC_`.** Bypasses Row Level Security and is used only in server Route Handlers.
- `NEXT_PUBLIC_MAPBOX_TOKEN` — Mapbox access token (used by later features: map display and geocoding). Note: Mapbox's permanent geocoding/storage terms require a credit card on file for the account, which will be needed before addresses can be stored long-term.

### Applying the database migration

The schema lives at `supabase/migrations/0001_init.sql`. Apply it with either:

**Supabase SQL editor** — open the project's SQL Editor in the Supabase dashboard, paste the contents of `supabase/migrations/0001_init.sql`, and run it.

**Supabase CLI**:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

## Intersection dataset

The intersection typeahead on `/report` searches a pre-processed static asset,
`public/data/toronto-intersections.json`, rather than calling a geocoding API.

**Attribution:** Contains information licensed under the
[Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/).
Source: [Intersection File - City of Toronto](https://open.toronto.ca/dataset/intersection-file-city-of-toronto/).

The raw source GeoJSON (~33.9 MB) lives in `datasets/` and is **gitignored** —
it is never committed. To regenerate the processed asset, download
`Centreline Intersection - 4326.geojson` into `datasets/` and run:

```bash
node scripts/build-intersections.mjs
```

The script filters ~46k raw nodes down to real street-level intersections and
writes a compact JSON file of `{ label, streets, lat, lng }` entries. It is a
one-time/manual step and is not part of `npm run build`.

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
