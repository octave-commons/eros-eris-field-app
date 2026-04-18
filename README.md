# eros-eris-field-app

A tiny **layout microservice** that nudges `devel-graph-weaver` nodes around using:

- Barnes–Hut N-body repulsion (quadtree)
- structural springs (imports/refs/etc)
- **semantic charge** based on embeddings (`qwen3-embedding:0.6b` via Ollama)

Myth name rationale:
- **Eros** pulls similar things together
- **Eris** pushes dissimilar things apart

## Run (docker)

```bash
docker compose -f orgs/octave-commons/eros-eris-field-app/compose.yaml up
```

Defaults assume:
- GraphQL: `http://127.0.0.1:8796/graphql`
- embeddings endpoint: `http://127.0.0.1:11434`

## Env (high signal)

- `GRAPHQL_URL` (default: `http://127.0.0.1:8796/graphql`)
- `GRAPHQL_ADMIN_TOKEN` (optional) – forwarded as `Authorization: Bearer ...`
- `OLLAMA_URL` (default: `http://127.0.0.1:11434`) – any Ollama-compatible `/api/embeddings` endpoint, including Proxx native embeddings mode
- `OLLAMA_AUTH_TOKEN` (optional) – bearer token for authenticated embedding gateways such as Proxx
- `OLLAMA_MODEL` (default: `qwen3-embedding:0.6b`)
- `VEXX_BASE_URL` (optional) – if set, semantic edge scoring offloads cosine matrix work to `vexx`
- `VEXX_API_KEY` (optional) – bearer token for authenticated `vexx`
- `VEXX_DEVICE` (default: `AUTO`) – `AUTO|CPU|GPU|NPU`
- `VEXX_REQUIRE_ACCEL` (default: `false`) – fail rather than fall back when accel is requested
- `VEXX_MIN_CANDIDATES` (default: `64`) – only offload when enough peer embeddings exist to amortize the HTTP round-trip
- `VEXX_TIMEOUT_MS` (default: `30000`) – cosine scoring timeout for `vexx` requests

- `SIM_MAX_NODES` (default: `6000`)
- `SIM_MAX_EDGES` (default: `12000`)
- `SIM_STEP_MS` (default: `5000`)
- `SIM_REFRESH_MS` (default: `30000`)
- `SIM_WRITE_MS` (default: `15000`)

- `SEMANTIC_ATTRACT_ABOVE` (default: `0.78`)
- `SEMANTIC_REPEL_BELOW` (default: `0.22`)

- `TARGET_RADIUS` (default: `5000`) — soft circular boundary radius
- `BOUNDARY_THICKNESS` (default: `650`) — thickness of the boundary-pressure band
- `BOUNDARY_PRESSURE` (default: `240`) — inward pressure strength near the boundary

## Notes

This service writes positions back to `devel-graph-weaver` via the GraphQL mutation:

- `layoutUpsertPositions(inputs: [NodePositionInput!]!): Int!`

Positions are stored in `node.data.pos = { x, y }` (overlay), so they survive rescan/weave rebuilds.
