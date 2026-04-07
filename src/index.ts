import {
  buildSemanticEdgesForCandidates,
  stepField,
  type FieldConfig,
  type Particle,
  type SemanticEdge,
  type SpringEdge,
  type VexxCosineConfig,
} from "@workspace/eros-eris-field";

type GraphViewNode = {
  id: string;
  kind: string;
  label: string;
  x: number;
  y: number;
  dataJson: string | null;
};

type GraphViewEdge = {
  source: string;
  target: string;
  kind: string;
  dataJson: string | null;
};

type GraphView = {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  meta: { totalNodes: number; totalEdges: number; sampledNodes: boolean; sampledEdges: boolean };
};

type NodePreview = {
  id: string;
  kind: string;
  format: string;
  contentType: string;
  language: string | null;
  body: string | null;
  truncated: boolean;
  bytes: number;
  status?: number | null;
  error?: string | null;
} | null;

type GraphNodeEmbeddingRow = {
  id: string;
  sourceEventId: string;
  embeddingModel: string | null;
  embeddingDimensions: number;
  embedding: number[];
  chunkCount: number;
};

type MaterializeGraphNodeEmbeddingInput = {
  id: string;
  body: string;
  sourceEventId?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const raw = String(process.env[name] ?? "").trim();
  return raw || fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function stripHtml(html: string): string {
  // Cheap + cheerful: remove scripts/styles and tags.
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson(maybe: string | null): any {
  if (!maybe) return null;
  try {
    return JSON.parse(maybe);
  } catch {
    return null;
  }
}

function inferLake(node: GraphViewNode): string {
  const data = parseJson(node.dataJson);
  return String(data?.lake || node.id.split(":", 1)[0] || "misc");
}

function inferNodeType(node: GraphViewNode): string {
  const data = parseJson(node.dataJson);
  return String(data?.node_type || node.kind || "node");
}

function lakeCenterX(lake: string): number {
  switch (lake) {
    case "devel": return -1400;
    case "web": return 0;
    case "bluesky": return 1400;
    default: return 0;
  }
}

function typeBandY(lake: string, nodeType: string): number {
  if (lake === "devel") {
    if (nodeType === "docs") return -360;
    if (nodeType === "code") return -120;
    if (nodeType === "config") return 120;
    if (nodeType === "data") return 360;
  }
  if (lake === "web") {
    if (nodeType === "visited") return -180;
    if (nodeType === "unvisited") return 180;
  }
  if (lake === "bluesky") {
    if (nodeType === "user") return -180;
    if (nodeType === "post") return 180;
  }
  return 0;
}

function applyLakeBands(params: {
  particles: Particle[];
  nodesById: Map<string, { lake: string; nodeType: string }>;
  dt: number;
}): void {
  const xStrength = 0.018;
  const yStrength = 0.012;

  for (const particle of params.particles) {
    const meta = params.nodesById.get(particle.id);
    if (!meta) continue;

    const targetX = lakeCenterX(meta.lake);
    const targetY = typeBandY(meta.lake, meta.nodeType);

    particle.vx += (targetX - particle.x) * xStrength * params.dt;
    particle.vy += (targetY - particle.y) * yStrength * params.dt;
  }
}

function nudgeInsideBoundary(particle: Particle, targetRadius: number, boundaryThickness: number): void {
  if (!(targetRadius > 0 && boundaryThickness > 0)) return;
  const r = Math.hypot(particle.x, particle.y);
  if (!(r > targetRadius - boundaryThickness)) return;
  const target = Math.max(0, targetRadius - boundaryThickness * 1.25);
  if (r <= 1e-6 || target <= 0) return;
  const s = target / r;
  particle.x *= s;
  particle.y *= s;
  particle.vx *= 0.4;
  particle.vy *= 0.4;
}

async function gql<T>(args: { url: string; adminToken: string | null; query: string; variables?: any }): Promise<T> {
  const res = await fetch(args.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(args.adminToken ? { authorization: `Bearer ${args.adminToken}` } : {}),
    },
    body: JSON.stringify({ query: args.query, variables: args.variables }),
  });

  const payload = (await res.json()) as any;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e: any) => e.message).join("; "));
  }
  return payload.data as T;
}

async function fetchGraphView(params: {
  graphqlUrl: string;
  adminToken: string | null;
  maxNodes: number;
  maxEdges: number;
}): Promise<GraphView> {
  const data = await gql<{ graphView: GraphView }>({
    url: params.graphqlUrl,
    adminToken: params.adminToken,
    query: `query View($n: Int!, $e: Int!) {
      graphView(maxNodes: $n, maxEdges: $e) {
        nodes { id kind label x y dataJson }
        edges { source target kind dataJson }
        meta { totalNodes totalEdges sampledNodes sampledEdges }
      }
    }`,
    variables: { n: params.maxNodes, e: params.maxEdges },
  });
  return data.graphView;
}

async function fetchNodePreview(params: {
  graphqlUrl: string;
  adminToken: string | null;
  id: string;
  maxBytes: number;
}): Promise<NodePreview> {
  const data = await gql<{ nodePreview: NodePreview }>({
    url: params.graphqlUrl,
    adminToken: params.adminToken,
    query: `query Preview($id: ID!, $m: Int!) {
      nodePreview(id: $id, maxBytes: $m) { id kind format contentType language body truncated bytes status error }
    }`,
    variables: { id: params.id, m: params.maxBytes },
  });
  return data.nodePreview;
}

async function fetchNodePreviews(params: {
  graphqlUrl: string;
  adminToken: string | null;
  ids: string[];
  maxBytes: number;
}): Promise<Array<NodePreview>> {
  if (params.ids.length === 0) return [];
  const data = await gql<{ nodePreviews: Array<NodePreview> }>({
    url: params.graphqlUrl,
    adminToken: params.adminToken,
    query: `query PreviewMany($ids: [ID!]!, $m: Int!) {
      nodePreviews(ids: $ids, maxBytes: $m) { id kind format contentType language body truncated bytes status error }
    }`,
    variables: { ids: params.ids, m: params.maxBytes },
  });
  return Array.isArray(data.nodePreviews) ? data.nodePreviews : [];
}

async function layoutUpsertPositions(params: {
  graphqlUrl: string;
  adminToken: string | null;
  inputs: Array<{ id: string; x: number; y: number }>;
}): Promise<number> {
  const data = await gql<{ layoutUpsertPositions: number }>({
    url: params.graphqlUrl,
    adminToken: params.adminToken,
    query: `mutation Upsert($xs: [NodePositionInput!]!) {
      layoutUpsertPositions(inputs: $xs)
    }`,
    variables: { xs: params.inputs },
  });
  return data.layoutUpsertPositions;
}

async function fetchOpenPlannerNodeEmbeddings(params: {
  openPlannerBaseUrl: string;
  openPlannerApiKey: string | null;
  ids: string[];
  eventIds: string[];
  model?: string;
}): Promise<GraphNodeEmbeddingRow[]> {
  const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) return [];

  const res = await fetch(`${baseUrl}/v1/graph/node-embeddings/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(params.openPlannerApiKey ? { authorization: `Bearer ${params.openPlannerApiKey}` } : {}),
    },
    body: JSON.stringify({
      ids: params.ids,
      eventIds: params.eventIds,
      model: params.model,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`openplanner node embeddings ${res.status}: ${text.slice(0, 200)}`);
  }

  const payload = JSON.parse(text) as { vectors?: unknown };
  const rows = Array.isArray(payload.vectors) ? payload.vectors : [];
  return rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const sourceEventId = typeof record.sourceEventId === "string" ? record.sourceEventId : "";
      const embedding = Array.isArray(record.embedding)
        ? record.embedding.map((value) => Number(value))
        : [];
      const embeddingDimensions = Number(record.embeddingDimensions ?? embedding.length);
      const chunkCount = Number(record.chunkCount ?? 0);
      if (!id || !sourceEventId || embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) return null;
      return {
        id,
        sourceEventId,
        embeddingModel: typeof record.embeddingModel === "string" ? record.embeddingModel : null,
        embeddingDimensions: Number.isFinite(embeddingDimensions) ? embeddingDimensions : embedding.length,
        embedding,
        chunkCount: Number.isFinite(chunkCount) ? chunkCount : 0,
      } satisfies GraphNodeEmbeddingRow;
    })
    .filter((row): row is GraphNodeEmbeddingRow => !!row);
}

async function materializeOpenPlannerNodeEmbeddings(params: {
  openPlannerBaseUrl: string;
  openPlannerApiKey: string | null;
  inputs: MaterializeGraphNodeEmbeddingInput[];
  model?: string;
}): Promise<GraphNodeEmbeddingRow[]> {
  const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl || params.inputs.length === 0) return [];

  const res = await fetch(`${baseUrl}/v1/graph/node-embeddings/materialize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(params.openPlannerApiKey ? { authorization: `Bearer ${params.openPlannerApiKey}` } : {}),
    },
    body: JSON.stringify({
      inputs: params.inputs,
      model: params.model,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`openplanner materialize node embeddings ${res.status}: ${text.slice(0, 200)}`);
  }

  const payload = JSON.parse(text) as { vectors?: unknown };
  const rows = Array.isArray(payload.vectors) ? payload.vectors : [];
  return rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const sourceEventId = typeof record.sourceEventId === "string" ? record.sourceEventId : "";
      const embedding = Array.isArray(record.embedding)
        ? record.embedding.map((value) => Number(value))
        : [];
      const embeddingDimensions = Number(record.embeddingDimensions ?? embedding.length);
      const chunkCount = Number(record.chunkCount ?? 0);
      if (!id || !sourceEventId || embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) return null;
      return {
        id,
        sourceEventId,
        embeddingModel: typeof record.embeddingModel === "string" ? record.embeddingModel : null,
        embeddingDimensions: Number.isFinite(embeddingDimensions) ? embeddingDimensions : embedding.length,
        embedding,
        chunkCount: Number.isFinite(chunkCount) ? chunkCount : 0,
      } satisfies GraphNodeEmbeddingRow;
    })
    .filter((row): row is GraphNodeEmbeddingRow => !!row);
}

async function upsertOpenPlannerSemanticEdges(params: {
  openPlannerBaseUrl: string;
  openPlannerApiKey: string | null;
  edges: SemanticEdge[];
  embeddingModel?: string;
  project?: string;
}): Promise<number> {
  const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl || params.edges.length === 0) return 0;

  const res = await fetch(`${baseUrl}/v1/graph/semantic-edges/upsert`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(params.openPlannerApiKey ? { authorization: `Bearer ${params.openPlannerApiKey}` } : {}),
    },
    body: JSON.stringify({
      edges: params.edges.map((e) => ({
        source: e.a,
        target: e.b,
        similarity: e.sim,
      })),
      embeddingModel: params.embeddingModel,
      project: params.project,
      source: "eros-eris-field",
      clusteringVersion: "v1",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`openplanner semantic edges upsert ${res.status}: ${text.slice(0, 200)}`);
  }

  const payload = JSON.parse(text) as { stored?: number };
  return payload.stored ?? 0;
}

async function upsertOpenPlannerEdges(params: {
  openPlannerBaseUrl: string;
  openPlannerApiKey: string | null;
  edges: Array<{ source: string; target: string; kind: string; data?: Record<string, unknown> }>;
  project?: string;
}): Promise<number> {
  const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl || params.edges.length === 0) return 0;

  const res = await fetch(`${baseUrl}/v1/graph/edges/upsert`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(params.openPlannerApiKey ? { authorization: `Bearer ${params.openPlannerApiKey}` } : {}),
    },
    body: JSON.stringify({
      edges: params.edges,
      project: params.project,
      source: "graph-weaver",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`openplanner edges upsert ${res.status}: ${text.slice(0, 200)}`);
  }

  const payload = JSON.parse(text) as { stored?: number };
  return payload.stored ?? 0;
}

function springProfile(kind: string): { strength: number; restLength: number } {
  switch (kind) {
    case "code_dependency":
      return { strength: 0.011, restLength: 90 };
    case "local_markdown_link":
      return { strength: 0.005, restLength: 130 };
    case "external_web_link":
      return { strength: 0.0035, restLength: 220 };
    case "visited_to_visited":
      return { strength: 0.0024, restLength: 180 };
    case "visited_to_unvisited":
      return { strength: 0.0028, restLength: 210 };
    case "follows_user":
      return { strength: 0.0025, restLength: 160 };
    case "authored_post":
    case "shared_post":
    case "liked_post":
      return { strength: 0.0032, restLength: 140 };
    case "post_links_visited_web":
    case "post_links_unvisited_web":
      return { strength: 0.003, restLength: 220 };
    default:
      return { strength: 0.002, restLength: 150 };
  }
}

function pickEmbedCandidates(params: {
  nodes: GraphViewNode[];
  degrees: Map<string, number>;
  embedded: Set<string>;
  limit: number;
}): GraphViewNode[] {
  const grouped = new Map<string, Array<{ node: GraphViewNode; score: number }>>();

  for (const n of params.nodes) {
    if (params.embedded.has(n.id)) continue;

    // Skip vendor / build artifacts (huge noise sinks for embeddings).
    if (
      n.id.includes("/node_modules/") ||
      n.id.includes("/.pnpm/") ||
      n.id.includes("/dist/") ||
      n.id.includes("/build/") ||
      n.id.includes("/.git/")
    ) {
      continue;
    }

    // embed the stuff that benefits most: code + markdown + urls
    if (!(n.kind === "file" || n.kind === "url" || n.kind === "dep")) continue;

    const d = params.degrees.get(n.id) ?? 0;
    const lake = inferLake(n);
    const nodeType = inferNodeType(n);
    const lakeBias = lake === "devel" ? 0.6 : lake === "web" ? 0.5 : 0.4;
    const typeBias = nodeType === "code" || nodeType === "docs" || nodeType === "visited" ? 0.35 : 0.15;
    const score = d + (n.kind === "file" ? 0.5 : 0) + lakeBias + typeBias;
    const key = `${lake}::${nodeType}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push({ node: n, score });
    grouped.set(key, bucket);
  }

  const buckets = [...grouped.values()]
    .map((bucket) => bucket.sort((a, b) => b.score - a.score))
    .sort((a, b) => (b[0]?.score ?? -Infinity) - (a[0]?.score ?? -Infinity));

  const chosen: GraphViewNode[] = [];
  while (chosen.length < Math.max(1, params.limit)) {
    let advanced = false;
    for (const bucket of buckets) {
      const row = bucket.shift();
      if (!row) continue;
      chosen.push(row.node);
      advanced = true;
      if (chosen.length >= Math.max(1, params.limit)) break;
    }
    if (!advanced) break;
  }

  return chosen;
}

function normalizeTextForEmbedding(input: string, maxChars: number): string {
  const s = String(input || "").replace(/\0/g, " ").trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

function summarizeField(params: {
  particles: Particle[];
  targetRadius: number;
  boundaryThickness: number;
}): {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  edgeBandFraction: number;
} {
  const radii = params.particles.map((p) => Math.hypot(p.x, p.y)).sort((a, b) => a - b);
  const count = radii.length;
  if (count === 0) {
    return { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0, edgeBandFraction: 0 };
  }

  const percentile = (p: number): number => {
    const idx = Math.max(0, Math.min(count - 1, Math.floor((count - 1) * p)));
    return radii[idx] ?? 0;
  };

  const inner = params.targetRadius - params.boundaryThickness;
  const edgeBand = inner > 0 ? radii.filter((r) => r >= inner).length / count : 0;
  const mean = radii.reduce((sum, r) => sum + r, 0) / count;

  return {
    p50: percentile(0.5),
    p75: percentile(0.75),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: radii[count - 1] ?? 0,
    mean,
    edgeBandFraction: edgeBand,
  };
}

async function main(): Promise<void> {
  const graphqlUrl = str("GRAPHQL_URL", "http://127.0.0.1:8796/graphql");
  const adminToken = String(process.env.GRAPHQL_ADMIN_TOKEN || "").trim() || null;
  const openPlannerBaseUrl = String(process.env.OPENPLANNER_BASE_URL || "").trim();
  const openPlannerApiKey = String(process.env.OPENPLANNER_API_KEY || "").trim() || null;

  // Embedding model for OpenPlanner materialization (OpenPlanner owns all embedding generation)
  const embeddingModel = str("OLLAMA_MODEL", "qwen3-embedding:0.6b");
  const embedContentMode = str("EMBED_CONTENT_MODE", "full").toLowerCase();
  const vexxBaseUrl = String(process.env.VEXX_BASE_URL || "").trim();
  const vexxApiKey = String(process.env.VEXX_API_KEY || "").trim() || undefined;
  const vexxDevice = str("VEXX_DEVICE", "AUTO") as VexxCosineConfig["device"];
  const vexxRequireAccel = /^(1|true|yes|on)$/i.test(String(process.env.VEXX_REQUIRE_ACCEL || ""));
  const vexxRequired = /^(1|true|yes|on)$/i.test(String(process.env.VEXX_ENFORCE || ""));
  const vexxMinCandidates = Math.max(1, Math.floor(num("VEXX_MIN_CANDIDATES", 64)));
  const vexxTimeoutMs = Math.max(1000, Math.floor(num("VEXX_TIMEOUT_MS", 30000)));
  const vexx: VexxCosineConfig | undefined = vexxBaseUrl
    ? {
        baseUrl: vexxBaseUrl,
        apiKey: vexxApiKey,
        device: vexxDevice,
        requireAccel: vexxRequireAccel,
        required: vexxRequired,
        minCandidates: vexxMinCandidates,
        timeoutMs: vexxTimeoutMs,
      }
    : undefined;

  const simMaxNodes = Math.floor(num("SIM_MAX_NODES", 6000));
  const simMaxEdges = Math.floor(num("SIM_MAX_EDGES", 12000));
  const stepMs = Math.floor(num("SIM_STEP_MS", 5000));
  const simSubsteps = Math.max(1, Math.floor(num("SIM_SUBSTEPS", 1)));
  const simDt = clamp(num("SIM_DT", 0.18), 0.01, 0.5);
  const refreshMs = Math.floor(num("SIM_REFRESH_MS", 30000));
  const writeMs = Math.max(15000, Math.floor(num("SIM_WRITE_MS", 15000)));
  const writeChunk = Math.max(250, Math.min(2000, Math.floor(num("SIM_WRITE_CHUNK", 400))));
  const writePauseMs = Math.max(25, Math.floor(num("SIM_WRITE_PAUSE_MS", 200)));

  const embedEveryMs = Math.max(1000, Math.floor(num("EMBED_EVERY_MS", 5000)));
  const embedBatchSize = Math.max(1, Math.min(64, Math.floor(num("EMBED_BATCH_SIZE", 32))));
  const embedMaxInFlight = Math.max(1, Math.min(8, Math.floor(num("EMBED_MAX_IN_FLIGHT", 4))));
  const embedPreviewMaxBytes = Math.floor(num("EMBED_PREVIEW_MAX_BYTES", 40000));
  const embedMaxChars = Math.floor(num("EMBED_MAX_CHARS", 6000));

  const semanticAttractAbove = clamp(num("SEMANTIC_ATTRACT_ABOVE", 0.72), -1, 1);
  const semanticRepelBelow = clamp(num("SEMANTIC_REPEL_BELOW", 0.08), -1, 1);
  const edgePullScale = num("EDGE_PULL_SCALE", 3.2);
  const edgeRestScale = clamp(num("EDGE_REST_SCALE", 0.84), 0.2, 2);

  const fieldConfig: FieldConfig = {
    theta: clamp(num("BH_THETA", 0.8), 0.2, 1.6),
    repulsionStrength: num("GLOBAL_REPULSION", num("REPULSION", 18)),
    localRepulsionRadius: num("LOCAL_REPULSION_RADIUS", 90),
    localRepulsionStrength: num("LOCAL_REPULSION", 3600),
    localRepulsionPower: num("LOCAL_REPULSION_POWER", 4),
    softening: num("SOFTENING", 18),
    damping: clamp(num("DAMPING", 0.90), 0, 1),
    maxSpeed: num("MAX_SPEED", 120),
    minSeparation: num("MIN_SEPARATION", 18),
    separationStrength: num("SEPARATION", 2600),

    semanticAttractAbove,
    semanticRepelBelow,
    semanticAttractStrength: num("SEMANTIC_ATTRACT", 0.11),
    semanticRepelStrength: num("SEMANTIC_REPEL", 1200),
    semanticRepelRadius: num("SEMANTIC_REPEL_RADIUS", 150),
    semanticRestLength: num("SEMANTIC_REST", 56),

    targetRadius: num("TARGET_RADIUS", 5000),

    boundaryThickness: num("BOUNDARY_THICKNESS", 650),
    boundaryPressure: num("BOUNDARY_PRESSURE", 60),
    boundaryEdgeFraction: clamp(num("BOUNDARY_EDGE_FRACTION", 0.04), 0.01, 0.5),
  };

  // simulation state
  const particlesById = new Map<string, Particle>();
  const nodeMetaById = new Map<string, { lake: string; nodeType: string }>();
  let springs: SpringEdge[] = [];
  let currentViewNodes: GraphViewNode[] = [];
  let currentDegrees = new Map<string, number>();

  // embeddings + semantic edges
  const embeddings = new Map<string, number[]>();
  const semanticPairs = new Map<string, SemanticEdge>();

  let lastRefresh = 0;
  let lastWrite = 0;
  let lastEmbed = 0;

  // Background embed pipeline state
  const embedInFlight = new Set<Promise<void>>();
  const claimedEmbeddingIds = new Set<string>();

  // eslint-disable-next-line no-console
  console.log(
    `[eros-eris] starting · graphql=${graphqlUrl} · openplanner=${openPlannerBaseUrl || "off"} · embeddingModel=${embeddingModel} · vexx=${vexxBaseUrl || "off"} device=${vexx?.device ?? "local"} · writeMs=${writeMs} chunk=${writeChunk} pause=${writePauseMs} · embedEveryMs=${embedEveryMs} batch=${embedBatchSize} inFlight=${embedMaxInFlight}`,
  );

  // Background embed worker - runs independently of main loop
  async function runEmbedBatch(batch: Array<{ id: string; vec: number[] }>, timings?: { embedMs?: number }): Promise<void> {
    if (batch.length === 0) return;
    const embedMs = timings?.embedMs ?? 0;
    const fresh = batch.map((b) => ({ id: b.id, vec: b.vec }));
    const existingPeers = [...embeddings.entries()].map(([id, embedding]) => ({ id, embedding }));
    const freshPeers = fresh.map((r) => ({ id: r.id, embedding: r.vec }));

    const semanticStart = Date.now();
    const semanticEdges = await buildSemanticEdgesForCandidates({
      candidates: freshPeers,
      peers: [...existingPeers, ...freshPeers],
      selection: {
        attractAbove: semanticAttractAbove,
        repelBelow: semanticRepelBelow,
        topK: Math.floor(num("SEMANTIC_TOP_K", 24)),
        bottomK: Math.floor(num("SEMANTIC_BOTTOM_K", 2)),
        vexx,
      },
    });
    const semanticMs = Date.now() - semanticStart;

    for (const r of fresh) embeddings.set(r.id, r.vec);
    for (const e of semanticEdges) {
      const key = e.a < e.b ? `${e.a}||${e.b}` : `${e.b}||${e.a}`;
      semanticPairs.set(key, e);
    }

    // Persist semantic edges to OpenPlanner (layout-as-search-index)
    if (openPlannerBaseUrl && semanticEdges.length > 0) {
      try {
        const upsertStart = Date.now();
        const stored = await upsertOpenPlannerSemanticEdges({
          openPlannerBaseUrl,
          openPlannerApiKey,
          edges: semanticEdges,
          embeddingModel,
        });
        if (stored > 0) {
          // eslint-disable-next-line no-console
          console.log(`[eros-eris] persisted ${stored} semantic edges to openplanner upsertMs=${Date.now() - upsertStart}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.warn(`[eros-eris] semantic edge persist failed: ${message}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[eros-eris] embedded batch=${fresh.length} peers=${existingPeers.length} newEdges=${semanticEdges.length} semanticPairs=${semanticPairs.size} nodes=${particlesById.size} embedMs=${embedMs} semanticMs=${semanticMs}`,
    );
  }

  // Run forever.
  for (;;) {
    const now = Date.now();

    if (now - lastRefresh >= refreshMs) {
      const viewStart = Date.now();
      const view = await fetchGraphView({
        graphqlUrl,
        adminToken,
        maxNodes: simMaxNodes,
        maxEdges: simMaxEdges,
      });
      const viewMs = Date.now() - viewStart;

      const present = new Set<string>();
      for (const n of view.nodes) {
        present.add(n.id);
        nodeMetaById.set(n.id, { lake: inferLake(n), nodeType: inferNodeType(n) });
        const p = particlesById.get(n.id);
        if (!p) {
          const created = { id: n.id, x: n.x, y: n.y, vx: 0, vy: 0, mass: 1 } satisfies Particle;
          nudgeInsideBoundary(created, fieldConfig.targetRadius, fieldConfig.boundaryThickness);
          particlesById.set(n.id, created);
        } else {
          // If node just arrived (or was reset), snap gently toward the current view position.
          p.x = Number.isFinite(p.x) ? p.x : n.x;
          p.y = Number.isFinite(p.y) ? p.y : n.y;
        }
      }

      for (const id of [...particlesById.keys()]) {
        if (!present.has(id)) {
          particlesById.delete(id);
          nodeMetaById.delete(id);
          for (const key of [...semanticPairs.keys()]) {
            if (key.startsWith(`${id}||`) || key.endsWith(`||${id}`)) {
              semanticPairs.delete(key);
            }
          }
        }
      }

      // degrees
      const degrees = new Map<string, number>();
      for (const e of view.edges) {
        degrees.set(e.source, (degrees.get(e.source) ?? 0) + 1);
        degrees.set(e.target, (degrees.get(e.target) ?? 0) + 1);
      }

      // structural springs
      const nodeSet = new Set(view.nodes.map((n) => n.id));
      springs = view.edges
        .filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target))
        .map((e) => {
          const prof = springProfile(e.kind);
          return {
            source: e.source,
            target: e.target,
            kind: e.kind,
            strength: prof.strength * edgePullScale,
            restLength: prof.restLength * edgeRestScale,
          } satisfies SpringEdge;
        });

      currentViewNodes = view.nodes;
      currentDegrees = degrees;

      // Persist ALL edges to OpenPlanner (layout-as-search-index)
      if (openPlannerBaseUrl && view.edges.length > 0) {
        try {
          const edgeStart = Date.now();
          const stored = await upsertOpenPlannerEdges({
            openPlannerBaseUrl,
            openPlannerApiKey,
            edges: view.edges.map((e) => ({
              source: e.source,
              target: e.target,
              kind: e.kind,
              data: e.dataJson ? JSON.parse(e.dataJson) : undefined,
            })),
          });
          if (stored > 0) {
            // eslint-disable-next-line no-console
            console.log(`[eros-eris] persisted ${stored} edges to openplanner edgeMs=${Date.now() - edgeStart}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // eslint-disable-next-line no-console
          console.warn(`[eros-eris] edge persist failed: ${message}`);
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[eros-eris] refresh viewNodes=${view.nodes.length}/${view.meta.totalNodes} viewEdges=${view.edges.length}/${view.meta.totalEdges} springs=${springs.length} fetchMs=${viewMs}`,
      );

      lastRefresh = now;
    }

    // --- queue embed candidates (non-blocking)
    if (now - lastEmbed >= embedEveryMs && currentViewNodes.length > 0 && embedInFlight.size < embedMaxInFlight) {
      const candidates = pickEmbedCandidates({
        nodes: currentViewNodes,
        degrees: currentDegrees,
        embedded: new Set([...embeddings.keys(), ...claimedEmbeddingIds]),
        limit: embedBatchSize,
      });

      if (candidates.length > 0) {
        lastEmbed = now;
        const candidateIds = candidates.map((candidate) => candidate.id);
        for (const id of candidateIds) claimedEmbeddingIds.add(id);
        // eslint-disable-next-line no-console
        console.log(`[eros-eris] embedding dispatch batch=${candidates.length} inFlight=${embedInFlight.size + 1}/${embedMaxInFlight}`);
        const embeddingStart = Date.now();
        const candidateEventIds = candidates
          .map((candidate) => {
            const data = parseJson(candidate.dataJson);
            return typeof data?.event_id === "string" ? data.event_id : "";
          })
          .filter(Boolean);

        const embeddingPromise = openPlannerBaseUrl
          ? fetchOpenPlannerNodeEmbeddings({
              openPlannerBaseUrl,
              openPlannerApiKey,
              ids: candidates.map((c) => c.id),
              eventIds: candidateEventIds,
              model: embeddingModel,
            })
          : Promise.resolve([] as GraphNodeEmbeddingRow[]);

        const task = embeddingPromise
          .then(async (rows) => {
            const openPlannerReady = rows.map((row) => ({ id: row.id, vec: row.embedding }));
            const openPlannerIds = new Set(openPlannerReady.map((row) => row.id));
            const missingCandidates = candidates.filter((candidate) => !openPlannerIds.has(candidate.id));
            const openPlannerEmbedMs = rows.length > 0 ? (Date.now() - embeddingStart) : 0;
            if (rows.length > 0) {
              // eslint-disable-next-line no-console
              console.log(`[eros-eris] openplanner embeddings batch=${rows.length} missing=${missingCandidates.length} embedMs=${openPlannerEmbedMs}`);
            }

            if (missingCandidates.length === 0) {
              return {
                mode: "openplanner" as const,
                ready: openPlannerReady,
                embedMs: openPlannerEmbedMs,
              };
            }

            const previewStart = Date.now();
            const previews = await fetchNodePreviews({
              graphqlUrl,
              adminToken,
              ids: missingCandidates.map((c) => c.id),
              maxBytes: embedPreviewMaxBytes,
            });
            const docs: Array<{ id: string; doc: string; input: MaterializeGraphNodeEmbeddingInput }> = [];
            for (let i = 0; i < missingCandidates.length; i++) {
              const candidate = missingCandidates[i]!;
              const preview = previews[i] ?? null;
              const data = parseJson(candidate.dataJson);
              const header = [candidate.kind, candidate.label, data?.path, data?.url, data?.dep]
                .filter((x) => typeof x === "string" && x.trim())
                .join("\n");
              let body = "";
              if (preview?.body) {
                body = preview.format === "html" ? stripHtml(preview.body) : preview.body;
              }
              docs.push({
                id: candidate.id,
                doc: normalizeTextForEmbedding(`${header}\n\n${body}`, embedMaxChars),
                input: {
                  id: candidate.id,
                  body: normalizeTextForEmbedding(body || header || candidate.id, embedMaxChars),
                  sourceEventId: typeof data?.event_id === "string" ? data.event_id : null,
                },
              });
            }
            const previewMs = Date.now() - previewStart;
            // eslint-disable-next-line no-console
            console.log(`[eros-eris] preview batch=${docs.length} previewMs=${previewMs}`);

            let canonicalMaterialized: Array<{ id: string; vec: number[] }> = [];
            if (openPlannerBaseUrl && docs.length > 0) {
              try {
                const materializeStart = Date.now();
                const rows = await materializeOpenPlannerNodeEmbeddings({
                  openPlannerBaseUrl,
                  openPlannerApiKey,
                  inputs: docs.map((doc) => doc.input),
                  model: embeddingModel,
                });
                canonicalMaterialized = rows.map((row) => ({ id: row.id, vec: row.embedding }));
                // eslint-disable-next-line no-console
                console.log(`[eros-eris] openplanner materialized batch=${rows.length} missing=${Math.max(0, docs.length - rows.length)} embedMs=${Date.now() - materializeStart}`);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // eslint-disable-next-line no-console
                console.warn(`[eros-eris] openplanner materialize failed: ${message}`);
              }
            }

            const canonicalIds = new Set(canonicalMaterialized.map((row) => row.id));
            const stillMissing = docs.filter((doc) => !canonicalIds.has(doc.id)).length;

            // OpenPlanner owns all embedding generation - no local fallback.
            // Missing embeddings will be picked up in future cycles when OpenPlanner's
            // background embedding pipeline processes them.
            if (stillMissing > 0) {
              // eslint-disable-next-line no-console
              console.log(`[eros-eris] ${stillMissing} nodes still missing embeddings - will retry next cycle`);
            }

            return {
              mode: rows.length > 0 ? ("hybrid" as const) : ("openplanner" as const),
              ready: [...openPlannerReady, ...canonicalMaterialized],
              embedMs: Date.now() - embeddingStart,
            };
          })
          .then(async (ready) => {
            if (ready.ready.length > 0) {
              await runEmbedBatch(ready.ready, { embedMs: ready.embedMs });
            }
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.warn(`[eros-eris] embedding refresh failed: ${msg}`);
          })
          .finally(() => {
            for (const id of candidateIds) claimedEmbeddingIds.delete(id);
            embedInFlight.delete(task);
          });
        embedInFlight.add(task);
      } else {
        lastEmbed = now;
      }
    }

    // --- simulate one or more substeps
    const particles = [...particlesById.values()];
    const semantic = [...semanticPairs.values()];
    for (let i = 0; i < simSubsteps; i += 1) {
      stepField({ particles, dt: simDt, config: fieldConfig, springs, semantic });
      applyLakeBands({ particles, nodesById: nodeMetaById, dt: simDt });
    }

    // --- write positions back (slow, chunked)
    if (now - lastWrite >= writeMs) {
      const inputs = particles.map((p) => ({ id: p.id, x: p.x, y: p.y }));
      const writeStart = Date.now();
      try {
        let total = 0;
        for (let i = 0; i < inputs.length; i += writeChunk) {
          const chunk = inputs.slice(i, i + writeChunk);
          const n = await layoutUpsertPositions({ graphqlUrl, adminToken, inputs: chunk });
          total += n;
          if (writePauseMs > 0) await sleep(writePauseMs);
        }
        const stats = summarizeField({
          particles,
          targetRadius: fieldConfig.targetRadius,
          boundaryThickness: fieldConfig.boundaryThickness,
        });
        // eslint-disable-next-line no-console
        console.log(
          `[eros-eris] wrote positions: ${total} nodes · radius p50=${stats.p50.toFixed(0)} p90=${stats.p90.toFixed(0)} p99=${stats.p99.toFixed(0)} max=${stats.max.toFixed(0)} mean=${stats.mean.toFixed(0)} edgeBand=${(stats.edgeBandFraction * 100).toFixed(1)}% semanticPairs=${semantic.length} springs=${springs.length} writeMs=${Date.now() - writeStart}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.warn(`[eros-eris] layout write failed: ${message}`);
      }
      lastWrite = now;
    }

    // Yield to event loop briefly so background promises can progress
    await sleep(Math.min(stepMs, 10));
  }
}

void main();
