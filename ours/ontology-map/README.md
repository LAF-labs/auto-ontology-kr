# @ours/ontology-map

The 데이터 지도 panel: the business terms of the connected Auto-ontology catalog as dots, the links between them as lines, and a side panel per term. Read-only and model-free.

- `index.js`: host row `ontology-map`. Registers `GET /api/ontology-map/graph` and `GET /api/ontology-map/entity?id=` on the shared API channel (owner cookie required).
- `src/map.js`: reads the gateway through `ctx.aoConnector` with the read token: `/api/exploration/semantic-graph`, `/api/saved-analyses` (verified versions only), `/api/exploration/tables/{id}/details` (the term a table `REPRESENTS`), `/api/terms/{id}`, `/api/terms/{id}/column-attributes`. Catalog sample values are never passed on.
- `src/layout.js`: deterministic force layout; the host sends positions, so the map looks the same on every visit.
- `src/routes.js`: caches the map for `cacheTtlS`; when reading again fails, answers the last map with `stale`.
- `client.js`: the panel (SVG, no chart library). The page calls only `/api/ontology-map/*`.

Config (`ontology-map` row): `cacheTtlS` (300), `maxEntities` (500, the gateway's cap), `mainCount` (12, entities in the first view: those confirmed analyses use, then the most linked).

Install into a home's web profile (after `@ours/ao-connector`):

```bash
DSH_HOME=<home> pnpm dsh plugin --profile web add link:<abs>/harness/ours/ontology-map
```

Tests: `node --test tests/*.test.js`.
