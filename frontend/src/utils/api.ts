
// API 地址配置
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export const TOKEN_KEY = 'xclaw_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/** 从已登录 JWT 中解析 Agent ID（注册接口签发的 JWT payload 含 agentId） */
export function getAgentIdFromToken(): string | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.agentId || payload.agent_id || payload.node_id || null;
  } catch {
    return null;
  }
}

export class AuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'AuthError';
  }
}

function getWsBaseUrl(): string {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}
const WS_BASE_URL = getWsBaseUrl();

/** 确保 WebSocket 地址只包含一个 /ws 路径（VITE_WS_URL 可能已含 /ws） */
function normalizeWsUrl(base: string): string {
  return /\/ws\/?$/.test(base) ? base : `${base.replace(/\/+$/, '')}/ws`;
}

/**
 * 通用的 REST API 请求方法
 */
export async function request(endpoint: string, options: RequestInit = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new AuthError('Login required');
    }
    const error = await response.json().catch(() => ({ message: 'API Request failed' }));
    throw new Error(error.message || `HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * 获取所有在线节点
 */
export async function fetchOnlineAgents() {
  return request('/v1/agents/online');
}

/**
 * 获取所有技能分类
 */
export async function fetchAgentDetail(agentId: string) {
  return request(`/v1/agents/${agentId}`);
}

export async function fetchAgentSkills(agentId: string) {
  return request(`/v1/agents/${agentId}/skills`);
}

export async function fetchAgentProfile(agentId: string) {
  return request(`/v1/agents/${agentId}/profile`);
}

export async function fetchSkillCategories() {
  return request('/v1/skills/categories');
}

/**
 * 获取拓扑数据
 */
export async function fetchTopology() {
  return request('/v1/topology');
}

/**
 * 获取 3D 拓扑数据（星系视图）
 */
export interface TopologyNode3D {
  id: string;
  name: string;
  capabilities: string[];
  reputation: number;
  online: boolean;
  position: [number, number, number];
  group?: number;
}

export interface TopologyEdge3D {
  source: string;
  target: string;
  weight: number;
}

export interface TopologyData {
  nodes: TopologyNode3D[];
  edges: TopologyEdge3D[];
}

export async function getTopology3D(timeRange?: string): Promise<TopologyData> {
  const qs = timeRange && timeRange !== 'live' ? `?time_range=${timeRange}` : '';
  const res = await request(`/v1/topology${qs}`);
  // Handle both { data: { nodes, edges } } and { nodes, edges } shapes
  const raw = res.data ?? res;
  return {
    nodes: raw.nodes ?? [],
    edges: raw.edges ?? [],
  };
}

/**
 * 全局搜索
 */
export async function searchGlobal(query: string, scope?: string) {
  return request('/v1/search', {
    method: 'POST',
    body: JSON.stringify({ query, scope })
  });
}

/**
 * 搜索技能
 */
export async function searchSkills(query: string, category?: string) {
  const params = new URLSearchParams();
  if (query) params.append('query', query);
  if (category) params.append('category', category);
  return request(`/v1/skills/search?${params.toString()}`);
}

export async function fetchMessages(agentId: string, params?: { limit?: number }) {
  const query = params ? `?limit=${params.limit || 30}` : '';
  return request(`/v1/agents/${agentId}/messages${query}`);
}

export async function markMessagesRead(agentId: string) {
  return request(`/v1/agents/${agentId}/messages/read`, { method: 'PUT' });
}

export async function fetchUnreadCount(agentId: string) {
  return request(`/v1/agents/${agentId}/messages/unread-count`);
}

export async function fetchSocialGraph() {
  return request('/v1/social-graph');
}

/**
 * 衰减社交图谱关系
 */
export async function decaySocialGraph() {
  return request('/v1/social-graph/decay', { method: 'POST' });
}

/**
 * 获取全局记忆统计
 */
export async function fetchMemoryStats() {
  return request('/v1/memory/stats');
}

/**
 * 获取技能详情
 */
export async function fetchSkillDetail(skillId: string) {
  return request(`/v1/skills/${skillId}`);
}

// ==========================================
// Auth API
// ==========================================

export async function login(apiKey: string) {
  const res = await request('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ api_key: apiKey })
  });
  if (res.success && res.data?.token) {
    setToken(res.data.token);
  }
  return res;
}

export async function logout() {
  clearToken();
}

// ==========================================
// ClawBay: 市场交易 API
// ==========================================

export async function fetchMarketplaceListings(params?: { category?: string; min_price?: number; max_price?: number; featured?: boolean; query?: string; sort?: string; order?: string; limit?: number; offset?: number }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/marketplace/listings${qs}`);
}

export async function fetchListingDetail(skillId: string) {
  return request(`/v1/marketplace/listings/${skillId}`);
}

export async function placeOrder(skillId: string, payload?: Record<string, unknown>) {
  return request('/v1/marketplace/orders', {
    method: 'POST',
    body: JSON.stringify({ skill_id: skillId, payload: payload || {} })
  });
}

/** 注册技能（创建技能记录） */
export async function registerSkill(payload: { name: string; description: string; category: string; version: string; node_id: string }) {
  return request('/v1/skills/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 上架技能到市场（定价） */
export async function listSkill(skillId: string, price: number) {
  return request('/v1/marketplace/list', {
    method: 'POST',
    body: JSON.stringify({ skill_id: skillId, price }),
  });
}

/** 下架技能 */
export async function delistSkill(skillId: string) {
  return request('/v1/marketplace/delist', {
    method: 'POST',
    body: JSON.stringify({ skill_id: skillId }),
  });
}

export async function fetchMyOrders(params?: { status?: string; limit?: number; offset?: number }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/marketplace/my/orders${qs}`);
}

export async function fetchMySales(params?: { status?: string; limit?: number; offset?: number }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/marketplace/my/sales${qs}`);
}

// ==========================================
// Task Operations API - 任务执行
// ==========================================

/**
 * 运行任务
 */
export async function runTask(payload: { skill_id: string; params?: Record<string, unknown>; timeout?: number }) {
  return request('/v1/tasks/run', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

/**
 * 轮询任务状态
 */
export async function pollTask(taskId: string) {
  return request(`/v1/tasks/${taskId}`);
}

/**
 * 完成任务
 */
export async function completeTask(taskId: string, payload?: { result?: unknown; logs?: string[] }) {
  return request(`/v1/tasks/${taskId}/complete`, {
    method: 'POST',
    body: JSON.stringify(payload || {})
  });
}

export async function fetchFeaturedSkills(limit = 6) {
  return request(`/v1/marketplace/featured?limit=${limit}`);
}

export async function fetchMarketplaceStats() {
  return request('/v1/marketplace/stats');
}

/**
 * 获取订单详情
 */
export async function fetchOrderDetail(orderId: string) {
  return request(`/v1/marketplace/orders/${orderId}`);
}

// ==========================================
// ClawOracle: 技能评价 API
// ==========================================

export async function postReview(skillId: string, rating: number, comment?: string, orderId?: string) {
  return request('/v1/reviews', {
    method: 'POST',
    body: JSON.stringify({ skill_id: skillId, rating, comment, order_id: orderId })
  });
}

export async function fetchSkillReviews(skillId: string, params?: { limit?: number; offset?: number; sortBy?: string }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/reviews/skill/${skillId}${qs}`);
}

export async function fetchReviewRankings(params?: { category?: string; limit?: number; min_reviews?: number }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/reviews/rankings${qs}`);
}

export async function fetchTopRatedSkills(limit = 10) {
  return request(`/v1/reviews/top-rated?limit=${limit}`);
}

export async function fetchCategoryRankings() {
  return request('/v1/reviews/categories');
}

/**
 * WebSocket 管理器
 */
// ==========================================
// Agent Memory API - 使用 /memories 路径 (与后端一致)
// ==========================================

/**
 * 获取 Agent 记忆列表
 */
export async function fetchAgentMemories(agentId: string, params?: { limit?: number; offset?: number; type?: string }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/agents/${agentId}/memories${qs}`);
}

/**
 * 添加 Agent 记忆
 */
export async function addAgentMemoryRaw(agentId: string, payload: { type?: string; content: string; related_agent_id?: string; task_id?: string; importance?: number }) {
  return request(`/v1/agents/${agentId}/memories`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

/**
 * 获取 Agent 记忆统计
 */
export async function fetchAgentMemoryStats(agentId: string) {
  return request(`/v1/agents/${agentId}/memories/stats`);
}

/**
 * 删除 Agent 记忆
 */
export async function deleteAgentMemoryRaw(agentId: string, memoryId: string) {
  return request(`/v1/agents/${agentId}/memories/${memoryId}`, { method: 'DELETE' });
}

// ==========================================
// Agent Relationships API - 单个 Agent 的关系管理
// ==========================================

/**
 * 获取 Agent 的关系列表
 */
export async function fetchAgentRelationships(agentId: string, params?: { limit?: number; type?: string }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/agents/${agentId}/relationships${qs}`);
}

/**
 * 删除 Agent 的某个关系
 */
export async function deleteAgentRelationship(agentId: string, relatedAgentId: string) {
  return request(`/v1/agents/${agentId}/relationships/${relatedAgentId}`, { method: 'DELETE' });
}

// ==========================================
// Agent Messages API - 离线消息
// ==========================================

/**
 * 获取离线消息
 */
export async function fetchOfflineMessages(agentId: string, params?: { limit?: number }) {
  const query = params ? `?limit=${params.limit || 50}` : '';
  return request(`/v1/agents/${agentId}/messages/offline${query}`);
}

/**
 * 获取离线消息数量
 */
export async function fetchOfflineMessageCount(agentId: string) {
  return request(`/v1/agents/${agentId}/messages/offline-count`);
}

// ==========================================
// Task Market API - 自动化任务市场
// ==========================================

export async function fetchTaskMarketStats() {
  return request('/v1/task-market/stats');
}

export async function browseTaskMarket(params?: { category?: string; min_budget?: number; max_budget?: number; status?: string; sort?: string; limit?: number; offset?: number }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/task-market/browse${qs}`);
}

export async function fetchMarketTask(taskId: string) {
  return request(`/v1/task-market/tasks/${taskId}`);
}

export async function createMarketTask(payload: { title: string; description: string; category: string; budget_min: number; budget_max: number; deadline?: string; required_capabilities?: string[]; assignment_strategy?: string; tags?: string[] }) {
  return request('/v1/task-market/tasks', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function submitBid(taskId: string, payload: { proposed_price: number; estimated_time?: string; cover_letter?: string; match_score?: number }) {
  return request(`/v1/task-market/tasks/${taskId}/bids`, {
    method: 'POST',
    body: JSON.stringify({
      proposed_price: payload.proposed_price,
      estimated_duration: payload.estimated_time,
      proposal: payload.cover_letter,
    })
  });
}

export async function fetchTaskBids(taskId: string) {
  return request(`/v1/task-market/tasks/${taskId}/bids`);
}

export async function acceptBid(taskId: string, bidId: string) {
  return request(`/v1/task-market/tasks/${taskId}/bids/${bidId}/accept`, {
    method: 'POST'
  });
}

export async function withdrawBid(taskId: string, bidId: string) {
  return request(`/v1/task-market/tasks/${taskId}/bids/${bidId}/withdraw`, {
    method: 'POST'
  });
}

export async function submitMarketResult(taskId: string, result: Record<string, unknown> | string) {
  return request(`/v1/task-market/tasks/${taskId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ result })
  });
}

export async function acceptMarketResult(taskId: string) {
  return request(`/v1/task-market/tasks/${taskId}/accept`, {
    method: 'POST'
  });
}

export async function rejectMarketResult(taskId: string, reason?: string) {
  return request(`/v1/task-market/tasks/${taskId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason || undefined })
  });
}

export async function cancelMarketTask(taskId: string) {
  return request(`/v1/task-market/tasks/${taskId}/cancel`, {
    method: 'POST'
  });
}

/** 向全网广播消息（需 Agent 登录，JWT 鉴权） */
export async function sendBroadcast(message: string, tags?: string[]) {
  return request('/v1/broadcast', {
    method: 'POST',
    body: JSON.stringify({ message, tags: tags || [] }),
  });
}

export async function autoAssignTask(taskId: string) {
  return request(`/v1/task-market/tasks/${taskId}/assign`, {
    method: 'POST'
  });
}

export async function completeMarketTask(taskId: string, payload?: { result?: Record<string, unknown>; rating?: number; review?: string }) {
  return request(`/v1/task-market/tasks/${taskId}/complete`, {
    method: 'POST',
    body: JSON.stringify(payload || {})
  });
}

export async function fetchTaskMatch(taskId: string) {
  return request(`/v1/task-market/tasks/${taskId}/matches`);
}

// ==========================================
// Federation API - 联邦网络
// ==========================================

export async function fetchFederationHealth() {
  return request('/v1/federation/health');
}

export async function registerFederationPeer(payload: { peer_id: string; name: string; endpoint_url: string; capabilities?: string[]; region?: string; metadata?: Record<string, unknown> }) {
  return request('/v1/federation/peers', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function listFederationPeers(params?: { status?: string; region?: string }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/federation/peers${qs}`);
}

export async function fetchFederationStatus() {
  return request('/v1/federation/status');
}

export async function routeFederatedTask(payload: { task_type: string; task_payload: Record<string, unknown>; preferred_regions?: string[]; max_hops?: number }) {
  return request('/v1/federation/task/route', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function unregisterFederationPeer(peerId: string) {
  return request(`/v1/federation/peers/${peerId}`, {
    method: 'DELETE'
  });
}

// ==========================================
// Monitor API - 企业级监控
// ==========================================

export async function fetchMonitorHealth() {
  return request('/v1/monitor/health');
}

export async function fetchDatabaseStats() {
  return request('/v1/monitor/database');
}

export async function fetchRedisStats() {
  return request('/v1/monitor/redis');
}

export async function fetchBusinessKPIs() {
  return request('/v1/monitor/kpis');
}

export async function fetchTimeSeries(params?: { metric?: string; interval?: string; start?: string; end?: string }) {
  const metric = params?.metric || 'requests';
  const qsParams: Record<string, string> = {};
  if (params?.interval) qsParams.interval = params.interval;
  if (params?.start) qsParams.start = params.start;
  if (params?.end) qsParams.end = params.end;
  const qs = Object.keys(qsParams).length > 0 ? '?' + Object.entries(qsParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
  return request(`/v1/monitor/timeseries/${metric}${qs}`);
}

export async function fetchAlerts(params?: { severity?: string; limit?: number; acknowledged?: boolean }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/monitor/alerts${qs}`);
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private token?: string;
  private onMessage: (data: unknown) => void;
  private onStatusChange: (connected: boolean) => void;
  private reconnectInterval: number = 3000;
  private shouldReconnect: boolean = true;

  constructor(agentId: string, onMessage: (data: unknown) => void, onStatusChange: (connected: boolean) => void, token?: string) {
    // token 不放入 URL（避免进入访问日志/代理），改为连接后通过 auth 消息发送
    this.token = token;
    this.url = `${normalizeWsUrl(WS_BASE_URL)}?agent_id=${encodeURIComponent(agentId)}`;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  connect() {
    console.log(`Connecting to WebSocket: ${this.url}`);
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.onStatusChange(true);
      if (this.token) {
        this.ws?.send(JSON.stringify({ type: 'auth', apiKey: this.token, agentId: 'monitor' }));
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.onMessage(data);
      } catch (error) {
        console.error('Failed to parse WebSocket message', error);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.onStatusChange(false);
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectInterval);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error', error);
      this.ws?.close();
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
  }
}


// ==========================================
// Memory API - Agent 记忆系统
// ==========================================

export async function fetchAgentMemory(agentId: string, params?: { limit?: number; category?: string }) {
  // 兼容旧路径，实际使用 /memories
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/agents/${agentId}/memories${qs}`);
}

export async function addAgentMemory(agentId: string, payload: { content: string; category?: string; tags?: string[] }) {
  return request(`/v1/agents/${agentId}/memories`, {
    method: 'POST',
    body: JSON.stringify({ content: payload.content, type: payload.category, tags: payload.tags })
  });
}

export async function deleteAgentMemory(agentId: string, memoryId: string) {
  return request(`/v1/agents/${agentId}/memories/${memoryId}`, { method: 'DELETE' });
}

// ==========================================
// Task API - 任务系统
// ==========================================

export async function fetchTasks(params?: { status?: string; agentId?: string; limit?: number; offset?: number }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/tasks${qs}`);
}

export async function createTask(payload: { title: string; description?: string; target_agent_id?: string; priority?: string; tags?: string[] }) {
  return request('/v1/tasks', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function updateTaskStatus(taskId: string, status: string, payload?: Record<string, unknown>) {
  return request(`/v1/tasks/${taskId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ...payload })
  });
}

export async function fetchTaskHistory(taskId: string) {
  return request(`/v1/tasks/${taskId}/history`);
}

// ==========================================
// Relationship API - 社交关系图谱
// ==========================================

export async function fetchRelationships(params?: { agentId?: string; limit?: number; type?: string }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/relationships${qs}`);
}

export async function fetchRelationshipStats() {
  return request('/v1/relationships/stats');
}

export async function addRelationship(payload: { from_agent_id: string; to_agent_id: string; type: string; strength?: number; tags?: string[] }) {
  return request('/v1/relationships', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// ==========================================
// Billing API - 计费系统
// ==========================================

export async function fetchBalance() {
  return request('/v1/billing/balance');
}

export async function fetchTransactions(params?: { limit?: number; offset?: number; type?: string }) {
  const qs = params ? '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request(`/v1/billing/transactions${qs}`);
}

export async function topUp(payload: { amount: number; method: string }) {
  return request('/v1/billing/topup', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// ==========================================
// Global Stats API
// ==========================================

export async function fetchGlobalStats() {
  return request('/v1/stats/global');
}

export async function fetchAgentStats(agentId: string) {
  return request(`/v1/agents/${agentId}/stats`);
}

// ==========================================
// A2A Protocol API
// ==========================================

export const fetchA2AStats = () => request('/v1/a2a/stats');
export const discoverA2AAgents = (query: string) => request(`/v1/a2a/agents/discover?query=${encodeURIComponent(query)}`);
export const publishA2AAgent = (card: object) => request('/v1/a2a/agents/publish', { method: 'POST', body: JSON.stringify(card) });
export const fetchA2AMessages = (agentId: string, limit = 20) => request(`/v1/a2a/messages/${agentId}?limit=${limit}`);

// ==========================================
// SearchV2 API
// ==========================================

export const fetchSearchV2Stats = () => request('/v1/search-v2/stats');
export const searchV2 = (query: string) => request('/v1/search-v2', { method: 'POST', body: JSON.stringify({ query }) });
export const fetchSearchV2Trending = (limit = 10) => request(`/v1/search-v2/trending?limit=${limit}`);
export const fetchSearchV2Gaps = () => request('/v1/search-v2/gaps');

// ==========================================
// MCP (Model Context Protocol) API
// ==========================================

export const fetchMCPStats = () => request('/v1/mcp/stats');
export const fetchMCPServers = () => request('/v1/mcp/servers');
export const fetchMCPTools = () => request('/v1/mcp/tools');
export const fetchMCPLogs = (limit = 50) => request(`/v1/mcp/logs?limit=${limit}`);

// ==========================================
// Developer Platform API
// ==========================================

export const registerDeveloper = (name: string, email: string) => request('/v1/developer/register', { method: 'POST', body: JSON.stringify({ name, email }) });
export const fetchSandboxStatus = () => request('/v1/developer/sandbox/status');
export const fetchSandboxAgents = () => request('/v1/developer/sandbox/agents');
export const fetchDeveloperApiKeys = () => request('/v1/developer/api-keys');

// ==========================================
// Security & Compliance API
// ==========================================

export const fetchSecurityStats = () => request('/v1/security/stats');
export const fetchOAuthClients = () => request('/v1/security/oauth/clients');
export const fetchAuditLogs = (limit = 50) => request(`/v1/security/audit/logs?limit=${limit}`);
export const fetchAuditStats = () => request('/v1/security/audit/stats');
export const fetchRateLimits = () => request('/v1/security/rate-limits');
