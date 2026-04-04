import { stepField, type FieldConfig, type Particle, type SemanticEdge, type SpringEdge } from "@workspace/eros-eris-field";

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

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
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

async function ollamaEmbedOne(params: {
  ollamaUrl: string;
  ollamaAuthToken: string | null;
  model: string;
  text: string;
  timeoutMs: number;
}): Promise<number[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, params.timeoutMs));
  try {
    const res = await fetch(`${params.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(params.ollamaAuthToken ? { authorization: `Bearer ${params.ollamaAuthToken}` } : {}),
      },
      body: JSON.stringify({ model: params.model, prompt: params.text, input: params.text }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`ollama embeddings ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = (await res.json()) as any;
    const vec = json?.embedding ?? json?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error("invalid embeddings response");
    return vec as number[];
  } finally {
    clearTimeout(timer);
  }
}

function springProfile(kind: string): { strength: number; restLength: number } {
  switch (kind) {
    case "import":
      return { strength: 0.010, restLength: 60 };
    case "dep":
      return { strength: 0.007, restLength: 86 };
    case "ref":
      return { strength: 0.004, restLength: 110 };
    case "link":
      return { strength: 0.0025, restLength: 140 };
    case "web":
      return { strength: 0.0018, restLength: 170 };
    default:
      return { strength: 0.002, restLength: 150 };
  }
}

function pickEmbedCandidate(params: {
  nodes: GraphViewNode[];
  degrees: Map<string, number>;
  embedded: Set<string>;
}): GraphViewNode | null {
  let best: GraphViewNode | null = null;
  let bestScore = -1;

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
    const score = d + (n.kind === "file" ? 0.5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }

  return best;
}

function normalizeTextForEmbedding(input: string, maxChars: number): string {
  const s = String(input || "").replace(/\0/g, " ").trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

async function main(): Promise<void> {
  const graphqlUrl = str("GRAPHQL_URL", "http://127.0.0.1:8796/graphql");
  const adminToken = String(process.env.GRAPHQL_ADMIN_TOKEN || "").trim() || null;

  const ollamaUrl = str("OLLAMA_URL", "http://127.0.0.1:11434");
  const ollamaAuthToken = String(process.env.OLLAMA_AUTH_TOKEN || "").trim() || null;
  const ollamaModel = str("OLLAMA_MODEL", "qwen3-embedding:0.6b");

  const simMaxNodes = Math.floor(num("SIM_MAX_NODES", 6000));
  const simMaxEdges = Math.floor(num("SIM_MAX_EDGES", 12000));
  const stepMs = Math.floor(num("SIM_STEP_MS", 5000));
  const simDt = clamp(num("SIM_DT", 0.18), 0.01, 0.5);
  const refreshMs = Math.floor(num("SIM_REFRESH_MS", 30000));
  const writeMs = Math.floor(num("SIM_WRITE_MS", 15000));
  const writeChunk = Math.floor(num("SIM_WRITE_CHUNK", 400));
  const writePauseMs = Math.floor(num("SIM_WRITE_PAUSE_MS", 200));

  const embedEveryMs = Math.floor(num("EMBED_EVERY_MS", 15000));
  const embedPreviewMaxBytes = Math.floor(num("EMBED_PREVIEW_MAX_BYTES", 40000));
  const embedMaxChars = Math.floor(num("EMBED_MAX_CHARS", 6000));

  const semanticAttractAbove = clamp(num("SEMANTIC_ATTRACT_ABOVE", 0.78), -1, 1);
  const semanticRepelBelow = clamp(num("SEMANTIC_REPEL_BELOW", 0.22), -1, 1);

  const fieldConfig: FieldConfig = {
    theta: clamp(num("BH_THETA", 0.8), 0.2, 1.6),
    repulsionStrength: num("REPULSION", 260),
    softening: num("SOFTENING", 30),
    damping: clamp(num("DAMPING", 0.90), 0, 1),
    maxSpeed: num("MAX_SPEED", 120),
    minSeparation: num("MIN_SEPARATION", 10),
    separationStrength: num("SEPARATION", 220),

    semanticAttractAbove,
    semanticRepelBelow,
    semanticAttractStrength: num("SEMANTIC_ATTRACT", 0.020),
    semanticRepelStrength: num("SEMANTIC_REPEL", 24),
    semanticRestLength: num("SEMANTIC_REST", 80),

    targetRadius: num("TARGET_RADIUS", 5000),

    boundaryThickness: num("BOUNDARY_THICKNESS", 650),
    boundaryPressure: num("BOUNDARY_PRESSURE", 240),
  };

  // simulation state
  const particlesById = new Map<string, Particle>();
  let springs: SpringEdge[] = [];

  // embeddings + semantic edges
  const embeddings = new Map<string, number[]>();
  const semanticPairs = new Map<string, SemanticEdge>();

  let lastRefresh = 0;
  let lastWrite = 0;
  let lastEmbed = 0;

  // eslint-disable-next-line no-console
  console.log(`[eros-eris] starting · graphql=${graphqlUrl} · ollama=${ollamaUrl} model=${ollamaModel}`);

  // Run forever.
  for (;;) {
    const now = Date.now();

    if (now - lastRefresh >= refreshMs) {
      const view = await fetchGraphView({
        graphqlUrl,
        adminToken,
        maxNodes: simMaxNodes,
        maxEdges: simMaxEdges,
      });

      const present = new Set<string>();
      for (const n of view.nodes) {
        present.add(n.id);
        const p = particlesById.get(n.id);
        if (!p) {
          particlesById.set(n.id, { id: n.id, x: n.x, y: n.y, vx: 0, vy: 0, mass: 1 });
        } else {
          // If node just arrived (or was reset), snap gently toward the current view position.
          p.x = Number.isFinite(p.x) ? p.x : n.x;
          p.y = Number.isFinite(p.y) ? p.y : n.y;
        }
      }

      for (const id of [...particlesById.keys()]) {
        if (!present.has(id)) {
          particlesById.delete(id);
          embeddings.delete(id);
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
            strength: prof.strength,
            restLength: prof.restLength,
          } satisfies SpringEdge;
        });

      // embed one candidate (slow)
      if (now - lastEmbed >= embedEveryMs) {
        const candidate = pickEmbedCandidate({
          nodes: view.nodes,
          degrees,
          embedded: new Set(embeddings.keys()),
        });

        if (candidate) {
          const preview = await fetchNodePreview({
            graphqlUrl,
            adminToken,
            id: candidate.id,
            maxBytes: embedPreviewMaxBytes,
          });

          const data = parseJson(candidate.dataJson);
          const header = [candidate.kind, candidate.label, data?.path, data?.url, data?.dep]
            .filter((x) => typeof x === "string" && x.trim())
            .join("\n");

          let body = "";
          if (preview?.body) {
            if (preview.format === "html") body = stripHtml(preview.body);
            else body = preview.body;
          }

          const doc = normalizeTextForEmbedding(`${header}\n\n${body}`, embedMaxChars);

          try {
            const vec = await ollamaEmbedOne({
              ollamaUrl,
              ollamaAuthToken,
              model: ollamaModel,
              text: doc,
              timeoutMs: 60_000,
            });
            embeddings.set(candidate.id, vec);

            // Update semantic pairs against existing embeddings.
            const topK = Math.floor(num("SEMANTIC_TOP_K", 10));
            const bottomK = Math.floor(num("SEMANTIC_BOTTOM_K", 6));

            const tops: Array<{ id: string; sim: number }> = [];
            const bottoms: Array<{ id: string; sim: number }> = [];

            for (const [otherId, otherVec] of embeddings) {
              if (otherId === candidate.id) continue;
              const sim = cosine(vec, otherVec);

              tops.push({ id: otherId, sim });
              bottoms.push({ id: otherId, sim });
            }

            tops.sort((a, b) => b.sim - a.sim);
            bottoms.sort((a, b) => a.sim - b.sim);

            const consider = [...tops.slice(0, topK), ...bottoms.slice(0, bottomK)];
            for (const row of consider) {
              const a = candidate.id;
              const b = row.id;
              const key = a < b ? `${a}||${b}` : `${b}||${a}`;
              const sim = row.sim;

              const charged = sim >= semanticAttractAbove || sim <= semanticRepelBelow;
              if (!charged) continue;

              semanticPairs.set(key, {
                a: a < b ? a : b,
                b: a < b ? b : a,
                sim,
              });
            }

            // eslint-disable-next-line no-console
            console.log(
              `[eros-eris] embedded ${candidate.id} · vec=${vec.length} · semanticPairs=${semanticPairs.size} · nodes=${particlesById.size}`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.warn(`[eros-eris] embed failed for ${candidate.id}: ${msg}`);
          }
        }

        lastEmbed = now;
      }

      lastRefresh = now;
    }

    // --- simulate one step
    const particles = [...particlesById.values()];
    const semantic = [...semanticPairs.values()];
    stepField({ particles, dt: simDt, config: fieldConfig, springs, semantic });

    // --- write positions back (slow, chunked)
    if (now - lastWrite >= writeMs) {
      const inputs = particles.map((p) => ({ id: p.id, x: p.x, y: p.y }));
      let total = 0;
      for (let i = 0; i < inputs.length; i += writeChunk) {
        const chunk = inputs.slice(i, i + writeChunk);
        const n = await layoutUpsertPositions({ graphqlUrl, adminToken, inputs: chunk });
        total += n;
        if (writePauseMs > 0) await sleep(writePauseMs);
      }
      // eslint-disable-next-line no-console
      console.log(`[eros-eris] wrote positions: ${total} nodes`);
      lastWrite = now;
    }

    await sleep(stepMs);
  }
}

void main();
