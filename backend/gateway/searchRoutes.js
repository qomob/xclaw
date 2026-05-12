import { Router } from 'express';
import { verifyApiKey } from './auth.js';
import searchServiceV2 from '../services/searchServiceV2.js';

const router = Router();
router.use(verifyApiKey);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /v1/search-v2 — 混合搜索
router.post('/v1/search-v2', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ success: false, error: 'query is required' });
  const result = await searchServiceV2.hybridSearch(req.body);
  res.json(result);
});

// GET /v1/search-v2/suggestions — 搜索建议
router.get('/v1/search-v2/suggestions', async (req, res) => {
  const { prefix, limit } = req.query;
  if (!prefix) return res.status(400).json({ success: false, error: 'prefix is required' });
  const result = await searchServiceV2.getSuggestions(prefix, parseInt(limit) || 10);
  res.json(result);
});

// GET /v1/search-v2/trending — 热门搜索
router.get('/v1/search-v2/trending', async (req, res) => {
  const result = await searchServiceV2.getTrendingSearches(parseInt(req.query.limit) || 10);
  res.json(result);
});

// GET /v1/search-v2/facets — 搜索分面
router.get('/v1/search-v2/facets', async (req, res) => {
  const result = await searchServiceV2.getSearchFacets(req.query.query);
  res.json(result);
});

// GET /v1/search-v2/similar/:agentId — 相似 Agent
router.get('/v1/search-v2/similar/:agentId', async (req, res) => {
  const { agentId } = req.params;
  if (!UUID_REGEX.test(agentId)) return res.status(400).json({ success: false, error: 'Invalid agentId' });
  const result = await searchServiceV2.getSimilarAgents(agentId, parseInt(req.query.limit) || 5);
  res.json(result);
});

// GET /v1/search-v2/clusters — Agent 聚类
router.get('/v1/search-v2/clusters', async (req, res) => {
  const result = await searchServiceV2.clusterAgents(parseInt(req.query.k) || 5);
  res.json(result);
});

// GET /v1/search-v2/gaps — 能力缺口分析
router.get('/v1/search-v2/gaps', async (_req, res) => {
  const result = await searchServiceV2.capabilityGapAnalysis();
  res.json(result);
});

// GET /v1/search-v2/stats — 搜索统计
router.get('/v1/search-v2/stats', async (_req, res) => {
  const result = await searchServiceV2.getSearchStats();
  res.json(result);
});

export default router;
