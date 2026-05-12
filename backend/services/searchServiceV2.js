import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, formatResponse } from '../core/utils.js';
import { generateEmbedding } from './aiService.js';
import logger from './loggerService.js';

class SearchServiceV2 {
  constructor() {
    this.pgPool = null;
    this.redis = null;
    this._initialized = false;
    this._tablesReady = false;
  }

  _getRedis() { if (!this.redis) this.redis = getRedis(); return this.redis; }
  _getPg() { if (!this.pgPool) this.pgPool = getPostgres(); return this.pgPool; }

  async init() {
    if (this._initialized) return;
    await this._ensureTables();
    this._initialized = true;
    logger.info('SearchServiceV2 initialized');
  }

  async _ensureTables() {
    if (this._tablesReady) return;
    const pg = this._getPg();
    await pg.query(`
      CREATE TABLE IF NOT EXISTS search_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        query TEXT NOT NULL,
        query_type VARCHAR(50) DEFAULT 'hybrid',
        results_count INTEGER DEFAULT 0,
        result_types JSONB DEFAULT '{}',
        filters JSONB DEFAULT '{}',
        user_id VARCHAR(255),
        response_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS search_suggestions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        text VARCHAR(500) NOT NULL UNIQUE,
        type VARCHAR(50) DEFAULT 'query',
        popularity INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    this._tablesReady = true;
  }

  // ==========================================
  // 核心混合搜索
  // ==========================================

  async hybridSearch(params) {
    const startTime = Date.now();
    const { query, types = ['agent', 'skill'], filters = {}, pagination = {}, scoring = {} } = params;
    const limit = pagination.limit || 20;
    const offset = pagination.offset || 0;
    const weights = { semantic: scoring.semantic ?? 0.6, keyword: scoring.keyword ?? 0.3, reputation: scoring.reputation ?? 0.1 };

    try {
      const [semanticResults, keywordResults] = await Promise.all([
        this._semanticSearch(query, types, limit * 3),
        this._keywordSearch(query, types, limit * 3),
      ]);

      let ranked = this._rankResults(semanticResults, keywordResults, weights);
      ranked = this._applyFilters(ranked, filters);
      const total = ranked.length;
      const paged = ranked.slice(offset, offset + limit);
      const facets = await this._getFacets(query);

      await this.recordSearch(query, total, null, filters, Date.now() - startTime);

      return formatResponse(true, { results: paged, total, offset, limit, facets });
    } catch (error) {
      logger.error('hybridSearch failed', { error: error.message, query });
      return formatResponse(false, null, error.message);
    }
  }

  async _semanticSearch(query, types, limit) {
    if (!query || !query.trim()) return [];
    const pg = this._getPg();
    const results = [];
    try {
      const embedding = await generateEmbedding(query);
      const vectorStr = `[${embedding.join(',')}]`;

      if (types.includes('agent')) {
        const r = await pg.query(`
          SELECT n.node_id AS id, n.name, n.status, n.reputation_score,
                 (ne.capability_vector <=> $1) AS distance, 'agent' AS result_type
          FROM nodes n JOIN node_embeddings ne ON n.node_id = ne.node_id
          WHERE (ne.capability_vector <=> $1) < 0.6
          ORDER BY ne.capability_vector <=> $1 ASC LIMIT $2
        `, [vectorStr, limit]);
        results.push(...r.rows);
      }

      if (types.includes('skill')) {
        const r = await pg.query(`
          SELECT s.id, s.name, s.description, s.category, s.node_id,
                 0.3 AS distance, 'skill' AS result_type
          FROM skills s
          WHERE s.name ILIKE $1 OR s.description ILIKE $1
          ORDER BY s.created_at DESC LIMIT $2
        `, [`%${query}%`, limit]);
        results.push(...r.rows);
      }
    } catch (error) {
      logger.warn('_semanticSearch fallback', { error: error.message });
    }
    return results;
  }

  async _keywordSearch(query, types, limit) {
    if (!query || !query.trim()) return [];
    const pg = this._getPg();
    const results = [];
    const tsQuery = query.trim().split(/\s+/).join(' | ');

    try {
      if (types.includes('agent')) {
        const r = await pg.query(`
          SELECT n.node_id AS id, n.name, n.status, n.reputation_score,
                 ts_rank_cd(to_tsvector('simple', COALESCE(n.name,'') || ' ' || COALESCE(n.status,'')), to_tsquery('simple', $1)) AS rank,
                 'agent' AS result_type
          FROM nodes n
          WHERE to_tsvector('simple', COALESCE(n.name,'') || ' ' || COALESCE(n.status,'')) @@ to_tsquery('simple', $1)
          ORDER BY rank DESC LIMIT $2
        `, [tsQuery, limit]);
        results.push(...r.rows);
      }

      if (types.includes('skill')) {
        const r = await pg.query(`
          SELECT s.id, s.name, s.description, s.category, s.node_id,
                 ts_rank_cd(to_tsvector('simple', COALESCE(s.name,'') || ' ' || COALESCE(s.description,'')), to_tsquery('simple', $1)) AS rank,
                 'skill' AS result_type
          FROM skills s
          WHERE to_tsvector('simple', COALESCE(s.name,'') || ' ' || COALESCE(s.description,'')) @@ to_tsquery('simple', $1)
          ORDER BY rank DESC LIMIT $2
        `, [tsQuery, limit]);
        results.push(...r.rows);
      }
    } catch (error) {
      logger.warn('_keywordSearch fallback', { error: error.message });
    }
    return results;
  }

  _rankResults(semanticResults, keywordResults, weights) {
    const K = 60; // RRF constant
    const scoreMap = new Map();

    for (let i = 0; i < semanticResults.length; i++) {
      const item = semanticResults[i];
      const key = `${item.result_type}:${item.id}`;
      const score = weights.semantic / (K + i + 1);
      const rep = (item.reputation_score || 0) / 100 * weights.reputation;
      scoreMap.set(key, { ...item, score: score + rep });
    }

    for (let i = 0; i < keywordResults.length; i++) {
      const item = keywordResults[i];
      const key = `${item.result_type}:${item.id}`;
      const score = weights.keyword / (K + i + 1);
      if (scoreMap.has(key)) {
        scoreMap.get(key).score += score;
      } else {
        scoreMap.set(key, { ...item, score });
      }
    }

    return [...scoreMap.values()].sort((a, b) => b.score - a.score);
  }

  _applyFilters(results, filters) {
    let filtered = results;
    if (filters.capabilities && filters.capabilities.length > 0) {
      filtered = filtered.filter(r =>
        r.capabilities && filters.capabilities.some(c => r.capabilities.includes(c))
      );
    }
    if (filters.min_reputation) {
      filtered = filtered.filter(r => (r.reputation_score || 0) >= filters.min_reputation);
    }
    if (filters.status) {
      filtered = filtered.filter(r => r.status === filters.status);
    }
    if (filters.category) {
      filtered = filtered.filter(r => r.category === filters.category);
    }
    return filtered;
  }

  async _getFacets(query) {
    const pg = this._getPg();
    try {
      const cats = await pg.query('SELECT category, COUNT(*) as count FROM skills GROUP BY category ORDER BY count DESC LIMIT 10');
      return { categories: cats.rows, capabilities: [], statuses: [] };
    } catch {
      return { categories: [], capabilities: [], statuses: [] };
    }
  }

  // ==========================================
  // 搜索增强
  // ==========================================

  async getSuggestions(prefix, limit = 10) {
    const pg = this._getPg();
    const redis = this._getRedis();
    try {
      // Check Redis trending first
      const trending = await redis.zrange('search:trending', 0, -1, 'WITHSCORES');
      const trendItems = [];
      for (let i = 0; i < trending.length; i += 2) {
        if (trending[i].toLowerCase().startsWith(prefix.toLowerCase())) {
          trendItems.push({ text: trending[i], score: parseFloat(trending[i + 1]) });
        }
      }

      if (trendItems.length >= limit) {
        return formatResponse(true, trendItems.slice(0, limit));
      }

      // DB fallback
      const result = await pg.query(`
        SELECT text, type, popularity FROM search_suggestions
        WHERE text ILIKE $1 ORDER BY popularity DESC LIMIT $2
      `, [`${prefix}%`, limit]);

      const combined = [...trendItems, ...result.rows.map(r => ({ text: r.text, type: r.type, score: r.popularity }))];
      // Deduplicate
      const seen = new Set();
      const unique = combined.filter(item => {
        if (seen.has(item.text)) return false;
        seen.add(item.text);
        return true;
      });

      return formatResponse(true, unique.slice(0, limit));
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  async recordSearch(query, resultsCount, userId, filters, responseTimeMs) {
    const pg = this._getPg();
    const redis = this._getRedis();
    try {
      await pg.query(`
        INSERT INTO search_logs (query, results_count, filters, user_id, response_time_ms)
        VALUES ($1, $2, $3, $4, $5)
      `, [query, resultsCount, JSON.stringify(filters || {}), userId || null, responseTimeMs || 0]);

      // Update trending
      await redis.zincrby('search:trending', 1, query);
    } catch (error) {
      logger.warn('recordSearch failed', { error: error.message });
    }
  }

  async getTrendingSearches(limit = 10) {
    const redis = this._getRedis();
    try {
      const results = await redis.zrange('search:trending', 0, limit - 1, 'REV', 'WITHSCORES');
      const items = [];
      for (let i = 0; i < results.length; i += 2) {
        items.push({ query: results[i], count: parseInt(results[i + 1]) });
      }
      return formatResponse(true, items);
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  async getSearchFacets(query) {
    const facets = await this._getFacets(query);
    return formatResponse(true, facets);
  }

  // ==========================================
  // Agent 聚类
  // ==========================================

  async clusterAgents(k = 5) {
    const pg = this._getPg();
    const redis = this._getRedis();
    try {
      // Check cache
      const cached = await redis.get('search:clusters');
      if (cached) return formatResponse(true, JSON.parse(cached));

      const { rows } = await pg.query(`
        SELECT n.node_id, n.name, ne.capability_vector
        FROM nodes n JOIN node_embeddings ne ON n.node_id = ne.node_id
        WHERE n.status = 'online' AND ne.capability_vector IS NOT NULL
      `);

      if (rows.length === 0) return formatResponse(true, { clusters: [], total_agents: 0 });

      // Parse vectors
      const vectors = rows.map(r => ({
        id: r.node_id,
        name: r.name,
        vec: typeof r.capability_vector === 'string'
          ? r.capability_vector.replace(/[\[\]]/g, '').split(',').map(Number)
          : r.capability_vector,
      }));

      const actualK = Math.min(k, vectors.length);
      const clusters = this._kmeans(vectors, actualK, 20);

      const result = { clusters, total_agents: vectors.length };
      await redis.set('search:clusters', JSON.stringify(result), 'EX', 3600);
      return formatResponse(true, result);
    } catch (error) {
      logger.error('clusterAgents failed', { error: error.message });
      return formatResponse(false, null, error.message);
    }
  }

  _kmeans(data, k, iterations) {
    // Initialize centroids randomly
    const centroids = [];
    const used = new Set();
    for (let i = 0; i < k; i++) {
      let idx;
      do { idx = Math.floor(Math.random() * data.length); } while (used.has(idx));
      used.add(idx);
      centroids.push([...data[idx].vec]);
    }

    const assignments = new Array(data.length).fill(0);

    for (let iter = 0; iter < iterations; iter++) {
      // Assign points to nearest centroid
      for (let i = 0; i < data.length; i++) {
        let minDist = Infinity;
        for (let c = 0; c < k; c++) {
          const dist = this._euclidean(data[i].vec, centroids[c]);
          if (dist < minDist) { minDist = dist; assignments[i] = c; }
        }
      }

      // Recompute centroids
      for (let c = 0; c < k; c++) {
        const members = data.filter((_, i) => assignments[i] === c);
        if (members.length === 0) continue;
        const dim = centroids[c].length;
        for (let d = 0; d < dim; d++) {
          centroids[c][d] = members.reduce((sum, m) => sum + m.vec[d], 0) / members.length;
        }
      }
    }

    // Build cluster objects
    return centroids.map((center, id) => {
      const agents = data.filter((_, i) => assignments[i] === id).map(d => ({ id: d.id, name: d.name }));
      return { id, center: center.slice(0, 5), agents, label: `Cluster ${id + 1}`, count: agents.length };
    });
  }

  _euclidean(a, b) {
    let sum = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
  }

  async getSimilarAgents(agentId, limit = 5) {
    const pg = this._getPg();
    try {
      const result = await pg.query(`
        SELECT n.node_id AS id, n.name, n.status, n.reputation_score,
               (ne.capability_vector <=> (
                 SELECT capability_vector FROM node_embeddings WHERE node_id = $1
               )) AS distance
        FROM nodes n JOIN node_embeddings ne ON n.node_id = ne.node_id
        WHERE n.node_id != $1 AND ne.capability_vector IS NOT NULL
        ORDER BY distance ASC LIMIT $2
      `, [agentId, limit]);
      return formatResponse(true, result.rows);
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  async capabilityGapAnalysis() {
    const pg = this._getPg();
    try {
      const agents = await pg.query(`
        SELECT node_id, capabilities FROM (
          SELECT n.node_id, n.name, n.capabilities as capabilities FROM nodes n WHERE n.status = 'online'
        ) sub
      `);

      const tasks = await pg.query(`
        SELECT type, COUNT(*) as demand_count FROM tasks GROUP BY type ORDER BY demand_count DESC LIMIT 20
      `);

      const supplyMap = {};
      for (const row of agents.rows) {
        const caps = (row.capabilities || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
        for (const cap of caps) {
          supplyMap[cap] = (supplyMap[cap] || 0) + 1;
        }
      }

      const gaps = tasks.rows.map(t => ({
        capability: t.type,
        demand_count: parseInt(t.demand_count),
        supply_count: supplyMap[t.type] || 0,
        gap_score: parseInt(t.demand_count) - (supplyMap[t.type] || 0),
      }));

      return formatResponse(true, { gaps, total_agents: agents.rows.length, total_task_types: tasks.rows.length });
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  // ==========================================
  // 统计
  // ==========================================

  async getSearchStats() {
    const pg = this._getPg();
    try {
      const [total, unique, avg] = await Promise.all([
        pg.query('SELECT COUNT(*) as count FROM search_logs'),
        pg.query('SELECT COUNT(DISTINCT query) as count FROM search_logs'),
        pg.query('SELECT AVG(results_count) as avg FROM search_logs'),
      ]);
      return formatResponse(true, {
        total_searches: parseInt(total.rows[0].count) || 0,
        unique_queries: parseInt(unique.rows[0].count) || 0,
        avg_results: parseFloat(avg.rows[0].avg) || 0,
      });
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  __resetForTesting() {
    this.pgPool = null;
    this.redis = null;
    this._initialized = false;
    this._tablesReady = false;
  }
}

const searchServiceV2 = new SearchServiceV2();
export default searchServiceV2;
