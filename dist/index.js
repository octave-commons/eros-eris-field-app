import { buildSemanticEdgesForCandidates, stepField, GraphAntSystem, } from "@workspace/eros-eris-field";
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function num(name, fallback) {
    const raw = process.env[name];
    const n = raw === undefined ? fallback : Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
function str(name, fallback) {
    const raw = String(process.env[name] ?? "").trim();
    return raw || fallback;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function stripHtml(html) {
    // Cheap + cheerful: remove scripts/styles and tags.
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function parseJson(maybe) {
    if (!maybe)
        return null;
    try {
        return JSON.parse(maybe);
    }
    catch {
        return null;
    }
}
function inferLake(node) {
    const data = parseJson(node.dataJson);
    return String(data?.lake || node.id.split(":", 1)[0] || "misc");
}
function inferNodeType(node) {
    const data = parseJson(node.dataJson);
    return String(data?.node_type || node.kind || "node");
}
function lakeCenterX(lake) {
    switch (lake) {
        case "devel": return -1400;
        case "web": return 0;
        case "bluesky": return 1400;
        default: return 0;
    }
}
function typeBandY(lake, nodeType) {
    if (lake === "devel") {
        if (nodeType === "docs")
            return -360;
        if (nodeType === "code")
            return -120;
        if (nodeType === "config")
            return 120;
        if (nodeType === "data")
            return 360;
    }
    if (lake === "web") {
        if (nodeType === "visited")
            return -180;
        if (nodeType === "unvisited")
            return 180;
    }
    if (lake === "bluesky") {
        if (nodeType === "user")
            return -180;
        if (nodeType === "post")
            return 180;
    }
    return 0;
}
function applyLakeBands(params) {
    const xStrength = 0.004;
    const yStrength = 0.0025;
    for (const particle of params.particles) {
        const meta = params.nodesById.get(particle.id);
        if (!meta)
            continue;
        const targetX = lakeCenterX(meta.lake);
        const targetY = typeBandY(meta.lake, meta.nodeType);
        particle.vx += (targetX - particle.x) * xStrength * params.dt;
        particle.vy += (targetY - particle.y) * yStrength * params.dt;
    }
}
function nudgeInsideBoundary(particle, targetRadius, boundaryThickness) {
    if (!(targetRadius > 0 && boundaryThickness > 0))
        return;
    const r = Math.hypot(particle.x, particle.y);
    if (!(r > targetRadius - boundaryThickness))
        return;
    const target = Math.max(0, targetRadius - boundaryThickness * 1.25);
    if (r <= 1e-6 || target <= 0)
        return;
    const s = target / r;
    particle.x *= s;
    particle.y *= s;
    particle.vx *= 0.4;
    particle.vy *= 0.4;
}
async function gql(args) {
    const res = await fetch(args.url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(args.adminToken ? { authorization: `Bearer ${args.adminToken}` } : {}),
        },
        body: JSON.stringify({ query: args.query, variables: args.variables }),
    });
    const payload = (await res.json());
    if (payload.errors?.length) {
        throw new Error(payload.errors.map((e) => e.message).join("; "));
    }
    return payload.data;
}
async function fetchGraphView(params) {
    const data = await gql({
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
async function fetchOpenPlannerGraphView(params) {
    const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl) {
        throw new Error("openplanner base url required");
    }
    const res = await fetch(`${baseUrl}/v1/graph/view`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(params.openPlannerApiKey ? { authorization: `Bearer ${params.openPlannerApiKey}` } : {}),
        },
        body: JSON.stringify({
            maxNodes: params.maxNodes,
            maxEdges: params.maxEdges,
            componentCount: params.componentCount,
            shardIndex: params.shardIndex,
            shardCount: params.shardCount,
            rotationCursor: params.rotationCursor,
        }),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`openplanner graph view ${res.status}: ${text.slice(0, 200)}`);
    }
    const payload = JSON.parse(text);
    return {
        nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
        edges: Array.isArray(payload.edges) ? payload.edges : [],
        meta: payload.meta ?? { totalNodes: 0, totalEdges: 0, sampledNodes: false, sampledEdges: false },
    };
}
async function fetchNodePreview(params) {
    const data = await gql({
        url: params.graphqlUrl,
        adminToken: params.adminToken,
        query: `query Preview($id: ID!, $m: Int!) {
      nodePreview(id: $id, maxBytes: $m) { id kind format contentType language body truncated bytes status error }
    }`,
        variables: { id: params.id, m: params.maxBytes },
    });
    return data.nodePreview;
}
async function fetchNodePreviews(params) {
    if (params.ids.length === 0)
        return [];
    const data = await gql({
        url: params.graphqlUrl,
        adminToken: params.adminToken,
        query: `query PreviewMany($ids: [ID!]!, $m: Int!) {
      nodePreviews(ids: $ids, maxBytes: $m) { id kind format contentType language body truncated bytes status error }
    }`,
        variables: { ids: params.ids, m: params.maxBytes },
    });
    return Array.isArray(data.nodePreviews) ? data.nodePreviews : [];
}
async function layoutUpsertPositions(params) {
    const graphWeaverBaseUrl = params.graphqlUrl.replace(/\/graphql\/?$/, "");
    try {
        const response = await fetch(`${graphWeaverBaseUrl}/api/layout/upsert`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(params.adminToken ? { authorization: `Bearer ${params.adminToken}` } : {}),
            },
            body: JSON.stringify({ inputs: params.inputs }),
        });
        const text = await response.text();
        if (response.ok) {
            const payload = JSON.parse(text);
            if (typeof payload.updated === "number")
                return payload.updated;
            return params.inputs.length;
        }
    }
    catch {
        // Fall back to GraphQL for older graph-weaver builds.
    }
    const data = await gql({
        url: params.graphqlUrl,
        adminToken: params.adminToken,
        query: `mutation Upsert($xs: [NodePositionInput!]!) {
      layoutUpsertPositions(inputs: $xs)
    }`,
        variables: { xs: params.inputs },
    });
    return data.layoutUpsertPositions;
}
async function fetchOpenPlannerNodeEmbeddings(params) {
    const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl)
        return [];
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
    const payload = JSON.parse(text);
    const rows = Array.isArray(payload.vectors) ? payload.vectors : [];
    return rows
        .map((row) => {
        const record = row;
        const id = typeof record.id === "string" ? record.id : "";
        const sourceEventId = typeof record.sourceEventId === "string" ? record.sourceEventId : "";
        const embedding = Array.isArray(record.embedding)
            ? record.embedding.map((value) => Number(value))
            : [];
        const embeddingDimensions = Number(record.embeddingDimensions ?? embedding.length);
        const chunkCount = Number(record.chunkCount ?? 0);
        if (!id || !sourceEventId || embedding.length === 0 || embedding.some((value) => !Number.isFinite(value)))
            return null;
        return {
            id,
            sourceEventId,
            embeddingModel: typeof record.embeddingModel === "string" ? record.embeddingModel : null,
            embeddingDimensions: Number.isFinite(embeddingDimensions) ? embeddingDimensions : embedding.length,
            embedding,
            chunkCount: Number.isFinite(chunkCount) ? chunkCount : 0,
        };
    })
        .filter((row) => !!row);
}
async function materializeOpenPlannerNodeEmbeddings(params) {
    const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl || params.inputs.length === 0)
        return [];
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
    const payload = JSON.parse(text);
    const rows = Array.isArray(payload.vectors) ? payload.vectors : [];
    return rows
        .map((row) => {
        const record = row;
        const id = typeof record.id === "string" ? record.id : "";
        const sourceEventId = typeof record.sourceEventId === "string" ? record.sourceEventId : "";
        const embedding = Array.isArray(record.embedding)
            ? record.embedding.map((value) => Number(value))
            : [];
        const embeddingDimensions = Number(record.embeddingDimensions ?? embedding.length);
        const chunkCount = Number(record.chunkCount ?? 0);
        if (!id || !sourceEventId || embedding.length === 0 || embedding.some((value) => !Number.isFinite(value)))
            return null;
        return {
            id,
            sourceEventId,
            embeddingModel: typeof record.embeddingModel === "string" ? record.embeddingModel : null,
            embeddingDimensions: Number.isFinite(embeddingDimensions) ? embeddingDimensions : embedding.length,
            embedding,
            chunkCount: Number.isFinite(chunkCount) ? chunkCount : 0,
        };
    })
        .filter((row) => !!row);
}
async function upsertOpenPlannerSemanticEdges(params) {
    const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl || params.edges.length === 0)
        return 0;
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
    const payload = JSON.parse(text);
    return payload.stored ?? 0;
}
async function fetchCanonicalSemanticEdges(params) {
    const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl)
        return [];
    const limit = Math.max(1, Math.min(100000, params.limit ?? 50000));
    const url = `${baseUrl}/v1/graph/semantic-edges?limit=${limit}`;
    const res = await fetch(url, {
        headers: {
            ...(params.openPlannerApiKey ? { authorization: `Bearer ${params.openPlannerApiKey}` } : {}),
        },
    });
    if (!res.ok) {
        throw new Error(`canonical semantic edges ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const payload = (await res.json());
    return payload.edges
        .filter((e) => params.nodeIds.has(e.source) && params.nodeIds.has(e.target))
        .map((e) => ({ a: e.source, b: e.target, sim: e.similarity }));
}
async function fetchOpenPlannerStructuralEdges(params) {
    const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl || params.nodeIds.length === 0)
        return [];
    const res = await fetch(`${baseUrl}/v1/graph/edges/query`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(params.openPlannerApiKey ? { authorization: `Bearer ${params.openPlannerApiKey}` } : {}),
        },
        body: JSON.stringify({
            nodeIds: params.nodeIds,
            limit: Math.max(1, Math.min(50000, params.limit ?? 50000)),
        }),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`openplanner structural edges ${res.status}: ${text.slice(0, 200)}`);
    }
    const payload = JSON.parse(text);
    return (Array.isArray(payload.edges) ? payload.edges : []).map((edge) => ({
        source: edge.source,
        target: edge.target,
        kind: edge.edgeKind,
        dataJson: edge.data ? JSON.stringify(edge.data) : null,
    }));
}
async function upsertOpenPlannerEdges(params) {
    const baseUrl = String(params.openPlannerBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl || params.edges.length === 0)
        return 0;
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
    const payload = JSON.parse(text);
    return payload.stored ?? 0;
}
function springProfile(kind) {
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
function pickEmbedCandidates(params) {
    const grouped = new Map();
    for (const n of params.nodes) {
        if (params.embedded.has(n.id))
            continue;
        // Skip vendor / build artifacts (huge noise sinks for embeddings).
        if (n.id.includes("/node_modules/") ||
            n.id.includes("/.pnpm/") ||
            n.id.includes("/dist/") ||
            n.id.includes("/build/") ||
            n.id.includes("/.git/")) {
            continue;
        }
        // embed the stuff that benefits most: code + markdown + urls
        if (!(n.kind === "file" || n.kind === "url" || n.kind === "dep"))
            continue;
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
    const chosen = [];
    while (chosen.length < Math.max(1, params.limit)) {
        let advanced = false;
        for (const bucket of buckets) {
            const row = bucket.shift();
            if (!row)
                continue;
            chosen.push(row.node);
            advanced = true;
            if (chosen.length >= Math.max(1, params.limit))
                break;
        }
        if (!advanced)
            break;
    }
    return chosen;
}
function normalizeTextForEmbedding(input, maxChars) {
    const s = String(input || "").replace(/\0/g, " ").trim();
    if (s.length <= maxChars)
        return s;
    return s.slice(0, maxChars);
}
function summarizeField(params) {
    const radii = params.particles.map((p) => Math.hypot(p.x, p.y)).sort((a, b) => a - b);
    const count = radii.length;
    if (count === 0) {
        return { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0, edgeBandFraction: 0 };
    }
    const percentile = (p) => {
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
async function main() {
    const workerRole = str("EROS_ERIS_WORKER_ROLE", "hybrid").toLowerCase();
    const graphqlUrl = str("GRAPHQL_URL", "http://127.0.0.1:8796/graphql");
    const adminToken = String(process.env.GRAPHQL_ADMIN_TOKEN || "").trim() || null;
    const openPlannerBaseUrl = String(process.env.OPENPLANNER_BASE_URL || "").trim();
    const openPlannerApiKey = String(process.env.OPENPLANNER_API_KEY || "").trim() || null;
    // Embedding model for OpenPlanner materialization (OpenPlanner owns all embedding generation)
    const embeddingModel = str("EMBED_PROVIDER_MODEL", "qwen3-embedding:0.6b");
    const embedContentMode = str("EMBED_CONTENT_MODE", "full").toLowerCase();
    const vexxBaseUrl = String(process.env.VEXX_BASE_URL || "").trim();
    const vexxApiKey = String(process.env.VEXX_API_KEY || "").trim() || undefined;
    const vexxDevice = str("VEXX_DEVICE", "AUTO");
    const vexxRequireAccel = /^(1|true|yes|on)$/i.test(String(process.env.VEXX_REQUIRE_ACCEL || ""));
    const vexxRequired = /^(1|true|yes|on)$/i.test(String(process.env.VEXX_ENFORCE || ""));
    const vexxMinCandidates = Math.max(1, Math.floor(num("VEXX_MIN_CANDIDATES", 64)));
    const vexxTimeoutMs = Math.max(1000, Math.floor(num("VEXX_TIMEOUT_MS", 30000)));
    const vexx = vexxBaseUrl
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
    const hydrateVisibleEmbeddings = !/^(0|false|no|off)$/i.test(String(process.env.HYDRATE_VISIBLE_EMBEDDINGS || "true"));
    const hydrateBatchSize = Math.max(64, Math.min(2000, Math.floor(num("HYDRATE_BATCH_SIZE", 1000))));
    const hydrateMaxBatchesPerRefresh = Math.max(1, Math.min(16, Math.floor(num("HYDRATE_MAX_BATCHES_PER_REFRESH", 4))));
    const semanticAttractAbove = clamp(num("SEMANTIC_ATTRACT_ABOVE", 0.72), -1, 1);
    const semanticRepelBelow = clamp(num("SEMANTIC_REPEL_BELOW", 0.08), -1, 1);
    const semanticSpatialOptimization = !/^(0|false|no|off)$/i.test(String(process.env.SEMANTIC_SPATIAL_OPTIMIZATION || "true"));
    const semanticMaxPeersPerCandidate = Math.max(32, Math.min(2048, Math.floor(num("SEMANTIC_MAX_PEERS_PER_CANDIDATE", 192))));
    const edgePullScale = num("EDGE_PULL_SCALE", 3.2);
    const edgeRestScale = clamp(num("EDGE_REST_SCALE", 0.84), 0.2, 2);
    const useCanonicalGraph = /^(1|true|yes|on)$/i.test(String(process.env.USE_CANONICAL_GRAPH || ""));
    const canonicalGraphRefreshMs = Math.max(1000, Math.floor(num("CANONICAL_GRAPH_REFRESH_MS", workerRole === "structural" ? 30000 : 300000)));
    const openPlannerStructuralEdgeLimit = Math.max(1000, Math.min(200000, Math.floor(num("OPENPLANNER_STRUCTURAL_EDGE_LIMIT", 50000))));
    const graphViewComponentCount = Math.max(1, Math.min(16, Math.floor(num("GRAPH_VIEW_COMPONENT_COUNT", 6))));
    const simShardCount = Math.max(1, Math.min(64, Math.floor(num("SIM_SHARD_COUNT", 1))));
    const simShardIndex = ((Math.floor(num("SIM_SHARD_INDEX", 0)) % simShardCount) + simShardCount) % simShardCount;
    const graphViewRotationEvery = Math.max(1, Math.min(32, Math.floor(num("GRAPH_VIEW_ROTATION_EVERY", 2))));
    const refreshPhaseOffsetMs = Math.floor((simShardIndex * refreshMs) / Math.max(1, simShardCount));
    const writePhaseOffsetMs = Math.floor((simShardIndex * writeMs) / Math.max(1, simShardCount));
    const enableSimulation = workerRole !== "semantic";
    const enableLayoutWrites = workerRole !== "semantic";
    const enableSemanticPipeline = workerRole !== "structural";
    const enableVisibleEmbeddingHydration = enableSemanticPipeline && hydrateVisibleEmbeddings;
    const enableStructuralEdgeHydration = workerRole !== "semantic";
    const enableStructuralEdgeUpsert = workerRole !== "semantic";
    const enableCanonicalGraphRefresh = workerRole === "structural" && useCanonicalGraph;
    const fieldConfig = {
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
        structuralClusterStrength: num("STRUCTURAL_CLUSTER", 0.02),
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
    const particlesById = new Map();
    const nodeMetaById = new Map();
    let springs = [];
    let antTrailEdges = [];
    let currentViewNodes = [];
    let currentDegrees = new Map();
    let refreshInFlight = null;
    let writeInFlight = null;
    const embeddings = new Map();
    const semanticPairs = new Map();
    const enableAntSystem = !/^(0|false|no)$/i.test(String(process.env.EROS_ERIS_ANT_SYSTEM ?? "true"));
    const antSystem = enableAntSystem
        ? new GraphAntSystem({
            antCount: Math.max(1, Math.floor(num("ANT_COUNT", 16))),
            stepsPerTick: Math.max(1, Math.floor(num("ANT_STEPS_PER_TICK", 8))),
            depositRate: num("ANT_DEPOSIT_RATE", 0.35),
            evaporationRate: num("ANT_EVAPORATION_RATE", 0.02),
            alpha: num("ANT_ALPHA", 1.2),
            beta: num("ANT_BETA", 3.0),
            revisitPenalty: num("ANT_REVISIT_PENALTY", 0.3),
            forceScale: num("ANT_FORCE_SCALE", 0.06),
            maxPheromone: num("ANT_MAX_PHEROMONE", 8),
        })
        : null;
    let lastRefresh = Date.now() - refreshMs + refreshPhaseOffsetMs;
    let lastWrite = Date.now() - writeMs + writePhaseOffsetMs;
    let lastEmbed = 0;
    let lastCanonicalGraph = 0;
    let currentCanonicalGraphVersion = null;
    let graphViewRefreshCount = 0;
    // Background embed pipeline state
    const embedInFlight = new Set();
    const claimedEmbeddingIds = new Set();
    let hydrateInFlight = null;
    // eslint-disable-next-line no-console
    console.log(`[eros-eris] starting · role=${workerRole} · graphql=${graphqlUrl} · openplanner=${openPlannerBaseUrl || "off"} · embeddingModel=${embeddingModel} · vexx=${vexxBaseUrl || "off"} device=${vexx?.device ?? "local"} · shard=${simShardIndex}/${simShardCount} rotationEvery=${graphViewRotationEvery} components=${graphViewComponentCount} refreshPhase=${refreshPhaseOffsetMs}ms writePhase=${writePhaseOffsetMs}ms · writeMs=${writeMs} chunk=${writeChunk} pause=${writePauseMs} · embedEveryMs=${embedEveryMs} batch=${embedBatchSize} inFlight=${embedMaxInFlight}`);
    // Background embed worker - runs independently of main loop
    async function runEmbedBatch(batch, timings) {
        if (batch.length === 0)
            return;
        const embedMs = timings?.embedMs ?? 0;
        const fresh = batch.map((b) => ({ id: b.id, vec: b.vec }));
        const existingPeers = [...embeddings.entries()].map(([id, embedding]) => ({
            id,
            embedding,
            x: particlesById.get(id)?.x,
            y: particlesById.get(id)?.y,
        }));
        const freshPeers = fresh.map((r) => ({
            id: r.id,
            embedding: r.vec,
            x: particlesById.get(r.id)?.x,
            y: particlesById.get(r.id)?.y,
        }));
        const semanticStart = Date.now();
        const semanticEdges = await buildSemanticEdgesForCandidates({
            candidates: freshPeers,
            peers: [...existingPeers, ...freshPeers],
            selection: {
                attractAbove: semanticAttractAbove,
                repelBelow: semanticRepelBelow,
                topK: Math.floor(num("SEMANTIC_TOP_K", 24)),
                bottomK: Math.floor(num("SEMANTIC_BOTTOM_K", 2)),
                useSpatialOptimization: semanticSpatialOptimization,
                maxPeersPerCandidate: semanticMaxPeersPerCandidate,
                vexx,
            },
        });
        const semanticMs = Date.now() - semanticStart;
        for (const r of fresh)
            embeddings.set(r.id, r.vec);
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
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // eslint-disable-next-line no-console
                console.warn(`[eros-eris] semantic edge persist failed: ${message}`);
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[eros-eris] embedded batch=${fresh.length} peers=${existingPeers.length} newEdges=${semanticEdges.length} semanticPairs=${semanticPairs.size} nodes=${particlesById.size} embedMs=${embedMs} semanticMs=${semanticMs}`);
    }
    // Run forever.
    for (;;) {
        const now = Date.now();
        if (now - lastRefresh >= refreshMs && !refreshInFlight) {
            refreshInFlight = (async () => {
                const refreshStartedAt = Date.now();
                const viewStart = Date.now();
                const rotationCursor = Math.floor(graphViewRefreshCount / graphViewRotationEvery);
                const view = openPlannerBaseUrl
                    ? await fetchOpenPlannerGraphView({
                        openPlannerBaseUrl,
                        openPlannerApiKey,
                        maxNodes: simMaxNodes,
                        maxEdges: simMaxEdges,
                        componentCount: graphViewComponentCount,
                        shardIndex: simShardIndex,
                        shardCount: simShardCount,
                        rotationCursor,
                    })
                    : await fetchGraphView({
                        graphqlUrl,
                        adminToken,
                        maxNodes: simMaxNodes,
                        maxEdges: simMaxEdges,
                    });
                const viewMs = Date.now() - viewStart;
                const present = new Set();
                for (const n of view.nodes) {
                    present.add(n.id);
                    nodeMetaById.set(n.id, { lake: inferLake(n), nodeType: inferNodeType(n) });
                    const p = particlesById.get(n.id);
                    if (!p) {
                        const created = { id: n.id, x: n.x, y: n.y, vx: 0, vy: 0, mass: 1 };
                        nudgeInsideBoundary(created, fieldConfig.targetRadius, fieldConfig.boundaryThickness);
                        particlesById.set(n.id, created);
                    }
                    else {
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
                let structuralEdges = view.edges;
                if (enableStructuralEdgeHydration && openPlannerBaseUrl && view.nodes.length > 0) {
                    try {
                        const openPlannerEdges = await fetchOpenPlannerStructuralEdges({
                            openPlannerBaseUrl,
                            openPlannerApiKey,
                            nodeIds: view.nodes.map((node) => node.id),
                            limit: openPlannerStructuralEdgeLimit,
                        });
                        if (openPlannerEdges.length > 0)
                            structuralEdges = openPlannerEdges;
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.warn(`[eros-eris] structural edge hydrate failed: ${message}`);
                    }
                }
                const degrees = new Map();
                for (const e of structuralEdges) {
                    degrees.set(e.source, (degrees.get(e.source) ?? 0) + 1);
                    degrees.set(e.target, (degrees.get(e.target) ?? 0) + 1);
                }
                const nodeSet = new Set(view.nodes.map((n) => n.id));
                springs = structuralEdges
                    .filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target))
                    .map((e) => {
                    const prof = springProfile(e.kind);
                    return {
                        source: e.source,
                        target: e.target,
                        kind: e.kind,
                        strength: prof.strength * edgePullScale,
                        restLength: prof.restLength * edgeRestScale,
                    };
                });
                if (antSystem)
                    antSystem.updateGraph(springs);
                currentViewNodes = view.nodes;
                currentDegrees = degrees;
                if (enableVisibleEmbeddingHydration && openPlannerBaseUrl && !hydrateInFlight) {
                    const visibleIds = view.nodes.map((n) => n.id).filter((id) => !embeddings.has(id));
                    if (visibleIds.length > 0) {
                        const idsToHydrate = visibleIds.slice(0, hydrateBatchSize * hydrateMaxBatchesPerRefresh);
                        hydrateInFlight = (async () => {
                            let fetched = 0;
                            let newlyCached = 0;
                            for (let i = 0; i < idsToHydrate.length; i += hydrateBatchSize) {
                                const chunkIds = idsToHydrate.slice(i, i + hydrateBatchSize);
                                const rows = await fetchOpenPlannerNodeEmbeddings({
                                    openPlannerBaseUrl,
                                    openPlannerApiKey,
                                    ids: chunkIds,
                                    eventIds: [],
                                    model: embeddingModel,
                                });
                                fetched += rows.length;
                                for (const row of rows) {
                                    if (!embeddings.has(row.id))
                                        newlyCached += 1;
                                    embeddings.set(row.id, row.embedding);
                                }
                            }
                            if (fetched > 0) {
                                console.log(`[eros-eris] hydrated visible embeddings fetched=${fetched} newlyCached=${newlyCached} cached=${embeddings.size}/${view.nodes.length}`);
                            }
                        })()
                            .catch((error) => {
                            const message = error instanceof Error ? error.message : String(error);
                            console.warn(`[eros-eris] visible embedding hydrate failed: ${message}`);
                        })
                            .finally(() => {
                            hydrateInFlight = null;
                        });
                    }
                }
                if (enableStructuralEdgeUpsert && openPlannerBaseUrl && view.edges.length > 0) {
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
                            console.log(`[eros-eris] persisted ${stored} edges to openplanner edgeMs=${Date.now() - edgeStart}`);
                        }
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.warn(`[eros-eris] edge persist failed: ${message}`);
                    }
                }
                console.log(`[eros-eris] refresh shard=${simShardIndex}/${simShardCount} cursor=${rotationCursor} used=${String(view.meta?.rotationCursorUsed ?? rotationCursor)} viewNodes=${view.nodes.length}/${view.meta.totalNodes} viewEdges=${view.edges.length}/${view.meta.totalEdges} structuralEdges=${structuralEdges.length} springs=${springs.length} fetchMs=${viewMs}`);
                if (enableCanonicalGraphRefresh && openPlannerBaseUrl && refreshStartedAt - lastCanonicalGraph >= canonicalGraphRefreshMs) {
                    try {
                        const canonicalStart = Date.now();
                        const canonicalEdges = await fetchCanonicalSemanticEdges({
                            openPlannerBaseUrl,
                            openPlannerApiKey,
                            nodeIds: present,
                        });
                        for (const e of canonicalEdges) {
                            const key = e.a < e.b ? `${e.a}||${e.b}` : `${e.b}||${e.a}`;
                            semanticPairs.set(key, e);
                        }
                        console.log(`[eros-eris] canonical graph loaded canonicalEdges=${canonicalEdges.length} totalSemanticPairs=${semanticPairs.size} canonicalMs=${Date.now() - canonicalStart}`);
                        lastCanonicalGraph = Date.now();
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.warn(`[eros-eris] canonical graph load failed: ${message}`);
                    }
                }
                lastRefresh = Date.now();
                graphViewRefreshCount += 1;
            })()
                .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[eros-eris] refresh failed: ${message}`);
            })
                .finally(() => {
                refreshInFlight = null;
            });
        }
        // --- queue embed candidates (non-blocking)
        if (enableSemanticPipeline && now - lastEmbed >= embedEveryMs && currentViewNodes.length > 0 && embedInFlight.size < embedMaxInFlight) {
            const candidates = pickEmbedCandidates({
                nodes: currentViewNodes,
                degrees: currentDegrees,
                embedded: new Set([...embeddings.keys(), ...claimedEmbeddingIds]),
                limit: embedBatchSize,
            });
            if (candidates.length > 0) {
                lastEmbed = now;
                const candidateIds = candidates.map((candidate) => candidate.id);
                for (const id of candidateIds)
                    claimedEmbeddingIds.add(id);
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
                    : Promise.resolve([]);
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
                            mode: "openplanner",
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
                    const docs = [];
                    for (let i = 0; i < missingCandidates.length; i++) {
                        const candidate = missingCandidates[i];
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
                    let canonicalMaterialized = [];
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
                        }
                        catch (error) {
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
                        mode: rows.length > 0 ? "hybrid" : "openplanner",
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
                    for (const id of candidateIds)
                        claimedEmbeddingIds.delete(id);
                    embedInFlight.delete(task);
                });
                embedInFlight.add(task);
            }
            else {
                lastEmbed = now;
            }
        }
        // --- simulate one or more substeps
        const particles = [...particlesById.values()];
        const semantic = [...semanticPairs.values()];
        if (enableSimulation) {
            if (antSystem) {
                const trails = antSystem.tick();
                antTrailEdges = trails.map((t) => ({
                    source: t.source,
                    target: t.target,
                    strength: t.strength,
                    restLength: t.restLength,
                }));
            }
            const allSprings = [...springs, ...antTrailEdges];
            for (let i = 0; i < simSubsteps; i += 1) {
                stepField({ particles, dt: simDt, config: fieldConfig, springs: allSprings, semantic });
                applyLakeBands({ particles, nodesById: nodeMetaById, dt: simDt });
            }
        }
        // --- write positions back (slow, chunked)
        if (enableLayoutWrites && particles.length > 0 && now - lastWrite >= writeMs && !writeInFlight) {
            const inputs = particles.map((p) => ({ id: p.id, x: p.x, y: p.y }));
            const semanticCount = semantic.length;
            const springCount = springs.length;
            writeInFlight = (async () => {
                const writeStart = Date.now();
                try {
                    let total = 0;
                    try {
                        total = await layoutUpsertPositions({ graphqlUrl, adminToken, inputs });
                    }
                    catch {
                        for (let i = 0; i < inputs.length; i += writeChunk) {
                            const chunk = inputs.slice(i, i + writeChunk);
                            const n = await layoutUpsertPositions({ graphqlUrl, adminToken, inputs: chunk });
                            total += n;
                            if (writePauseMs > 0)
                                await sleep(writePauseMs);
                        }
                    }
                    const stats = summarizeField({
                        particles,
                        targetRadius: fieldConfig.targetRadius,
                        boundaryThickness: fieldConfig.boundaryThickness,
                    });
                    const antStats = antSystem ? antSystem.stats() : null;
                    console.log(`[eros-eris] wrote positions: ${total} nodes · radius p50=${stats.p50.toFixed(0)} p90=${stats.p90.toFixed(0)} p99=${stats.p99.toFixed(0)} max=${stats.max.toFixed(0)} mean=${stats.mean.toFixed(0)} edgeBand=${(stats.edgeBandFraction * 100).toFixed(1)}% semanticPairs=${semanticCount} springs=${springCount}${antStats ? ` ants=${antStats.antCount} antEdges=${antStats.edgeCount} avgPh=${antStats.avgPheromone.toFixed(2)}` : ""} writeMs=${Date.now() - writeStart}`);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`[eros-eris] layout write failed: ${message}`);
                }
                lastWrite = Date.now();
            })().finally(() => {
                writeInFlight = null;
            });
        }
        // Yield to event loop briefly so background promises can progress
        await sleep(Math.min(stepMs, 1));
    }
}
void main();
//# sourceMappingURL=index.js.map