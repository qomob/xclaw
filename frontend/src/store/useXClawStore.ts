import { create } from 'zustand';
import { fetchOnlineAgents, fetchSkillCategories, getTopology3D, WebSocketManager, getToken } from '../utils/api';

// 日志类型定义
export interface Log {
  id: string;
  message: string;
  time: string;
  type: 'p2p' | 'channel';
}

// 警报类型定义
export interface Alert {
  id: number;
  message: string;
  level: 'high' | 'medium' | 'low' | 'info';
  time: string;
}

// 实时动态流条目（新 Agent 加入/离开、全网广播、P2P 消息）
export interface FeedItem {
  id: string;
  kind: 'agent' | 'broadcast' | 'p2p' | 'system';
  /** agent: 名称；broadcast/p2p: 发送方短 ID */
  who?: string;
  /** agent: joined | left */
  sub?: string;
  content?: string;
  time: string;
}

// Agent 分组类型定义
export interface AgentGroup {
  id: number;
  name: string;
  count: number;
  color: string;
}

// Agent 节点类型定义
export interface Agent {
  id: string;
  name: string;
  group: number;
  lat: number;
  lng: number;
  online: boolean;
  val?: number; // 拓扑图节点大小
  tags?: string[];
}

// Galaxy View 类型定义
export interface GalaxyNode {
  id: string;
  name: string;
  capabilities: string[];
  reputation: number;
  online: boolean;
  position: [number, number, number];
  group?: number;
}

export interface GalaxyEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GalaxyFilter {
  capabilities: string[];
  onlineOnly: boolean;
  minReputation: number;
}

export type GalaxyLayout = 'force' | 'sphere' | 'hierarchy';
export type GalaxyTimeRange = 'live' | '24h' | '7d' | '30d';

// 任务类型定义
export interface Task {
  id: string;
  from: string;
  to: string;
  from_lat: number;
  from_lng: number;
  to_lat: number;
  to_lng: number;
  source?: string; // 兼容后端 link 字段
  target?: string; // 兼容后端 link 字段
}

// 状态类型定义
interface XClawState {
  // 核心操作
  init: () => Promise<void>;
  destroy: () => void;

  // 日志相关
  logs: Log[];
  addLog: (log: Log) => void;
  clearLogs: () => void;
  startTicker: () => void;
  stopTicker: () => void;
  
  // 警报相关
  alerts: Alert[];
  addAlert: (alert: Alert) => void;
  clearAlerts: () => void;

  // 实时动态流
  feed: FeedItem[];
  addFeed: (item: Omit<FeedItem, 'id' | 'time'> & { time?: string }) => void;
  clearFeed: () => void;
  
  // Agent 分组相关
  agentGroups: AgentGroup[];
  setAgentGroups: (groups: AgentGroup[]) => void;
  
  // Agent 节点相关
  agents: Agent[];
  setAgents: (agents: Agent[]) => void;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  
  // 任务相关
  tasks: Task[];
  setTasks: (tasks: Task[]) => void;
  
  // 系统状态
  isConnected: boolean;
  setIsConnected: (connected: boolean) => void;
  tps: number;
  setTps: (tps: number) => void;
  networkLatency: number;
  setNetworkLatency: (latency: number) => void;

  // Galaxy View 星系可视化
  galaxyNodes: GalaxyNode[];
  galaxyEdges: GalaxyEdge[];
  galaxySelectedNode: string | null;
  galaxyHoveredNode: string | null;
  galaxyCameraPosition: [number, number, number];
  galaxyLayout: GalaxyLayout;
  galaxyFilter: GalaxyFilter;
  galaxyTimeRange: GalaxyTimeRange;
  setGalaxyNodes: (nodes: GalaxyNode[]) => void;
  setGalaxyEdges: (edges: GalaxyEdge[]) => void;
  setGalaxySelectedNode: (id: string | null) => void;
  setGalaxyHoveredNode: (id: string | null) => void;
  setGalaxyCameraPosition: (pos: [number, number, number]) => void;
  setGalaxyLayout: (layout: GalaxyLayout) => void;
  setGalaxyFilter: (filter: GalaxyFilter) => void;
  setGalaxyTimeRange: (range: GalaxyTimeRange) => void;
  fetchGalaxyData: () => Promise<void>;
}

// 模块顶级作用域的消息缓冲区，用于极速接收 WebSocket 消息
// 这里使用普通 JS 数组，避免在 WebSocket 回调中直接触发 React 重渲染
const messageBuffer: Log[] = [];

// 最大日志数量，超过时会剔除最旧的数据
const MAX_LOGS = 200;

/** 简单字符串哈希（用于确定性伪随机球面分布） */
function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * 将拓扑节点归一化为 GalaxyNode：
 * - 保证 position 始终存在（有经纬度则投影到球面，否则按节点 ID 哈希生成确定性位置）
 * - 兜底 id/name/capabilities/reputation/online 等字段
 */
function normalizeGalaxyNode(node: BackendNode, index: number): GalaxyNode {
  const id = String(node.id || node.node_id || `node-${index}`);
  const lat = Number(node.lat ?? node.latitude);
  const lng = Number(node.lng ?? node.longitude);

  let position: [number, number, number];
  if (
    Array.isArray(node.position) &&
    node.position.length === 3 &&
    node.position.every(v => typeof v === 'number' && Number.isFinite(v))
  ) {
    position = node.position as [number, number, number];
  } else if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    const phi = (lat * Math.PI) / 180;
    const theta = (lng * Math.PI) / 180;
    const r = 200;
    position = [
      r * Math.cos(phi) * Math.cos(theta),
      r * Math.sin(phi),
      r * Math.cos(phi) * Math.sin(theta),
    ];
  } else {
    // 确定性球面分布：同一节点多次渲染位置一致
    const seed = hashString(id);
    const phi = ((seed % 1000) / 1000) * Math.PI - Math.PI / 2;
    const theta = ((seed % 997) / 997) * Math.PI * 2;
    const r = 180 + (seed % 40);
    position = [
      r * Math.cos(phi) * Math.cos(theta),
      r * Math.sin(phi),
      r * Math.cos(phi) * Math.sin(theta),
    ];
  }

  return {
    id,
    name: node.name || id,
    capabilities: Array.isArray(node.capabilities)
      ? node.capabilities
      : typeof node.capabilities === 'string'
        ? node.capabilities.split(',')
        : [],
    reputation: Number(node.reputation ?? node.reputation_score ?? 0.5) || 0.5,
    online: Boolean(node.online ?? node.status === 'online'),
    position,
    group: Number(node.group || 1),
  };
}

interface APIResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

interface BackendNode {
  id?: string;
  node_id?: string;
  name: string;
  latitude?: number;
  longitude?: number;
  status?: string;
  tags?: string[];
  group?: number;
  val?: number;
  lat?: number;
  lng?: number;
  position?: number[];
  capabilities?: string[] | string;
  reputation?: number;
  reputation_score?: number;
  online?: boolean;
}

interface BackendCategory {
  name?: string;
  count?: number;
}

interface WSMessage {
  type: string;
  data: {
    nodes?: BackendNode[];
    links?: Array<{ source: string, target: string }>;
    sender_id?: string;
    recipient_id?: string;
    content?: string;
    tags?: string[];
    status?: 'online' | 'offline';
    agent_id?: string;
    agent_name?: string;
  };
  logType?: string;
}

// 创建 Zustand store
export const useXClawStore = create<XClawState>((set, get) => {
  let wsManager: WebSocketManager | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  return {
    // 初始状态
    logs: [],
    alerts: [],
    feed: [],
    agentGroups: [],
    agents: [],
    selectedAgentId: null,
    tasks: [],
    isConnected: false,
    tps: 0,
    networkLatency: 0,

    // Galaxy View 初始状态
    galaxyNodes: [],
    galaxyEdges: [],
    galaxySelectedNode: null,
    galaxyHoveredNode: null,
    galaxyCameraPosition: [0, 20, 50],
    galaxyLayout: 'sphere',
    galaxyFilter: { capabilities: [], onlineOnly: false, minReputation: 0 },
    galaxyTimeRange: 'live',

    // 初始化
    init: async () => {
      try {
        // 1. 获取初始数据
        const agentsData = await fetchOnlineAgents() as APIResponse<BackendNode[]>;
        const categoriesData = await fetchSkillCategories() as APIResponse<Array<string | BackendCategory>>;

        if (agentsData.success && agentsData.data) {
          const agents: Agent[] = agentsData.data.map((node) => ({
            id: node.id || node.node_id || '',
            name: node.name,
            group: Math.floor(Math.random() * 4) + 1,
            lat: Number(node.lat || node.latitude) || 0,
            lng: Number(node.lng || node.longitude) || 0,
            online: node.status === 'online',
            tags: node.tags || []
          }));
          set({ agents });
        }

        if (categoriesData.success && categoriesData.data) {
          const groups: AgentGroup[] = categoriesData.data.map((cat, index: number) => {
            const name = typeof cat === 'string' ? cat : (cat.name || 'Unknown');
            const count = typeof cat === 'string' ? 0 : (cat.count || 0);
            return {
              id: index + 1,
              name,
              count,
              color: ['#EF4444', '#10B981', '#0EA5E9', '#F59E0B', '#8B5CF6'][index % 5]
            };
          });
          set({ agentGroups: groups });
        }

        // 2. 建立 WebSocket 连接
        if (!wsManager) {
          wsManager = new WebSocketManager(
            'monitor',
            (message: unknown) => {
              const msg = message as WSMessage;
              const { type, data, logType } = msg;

              switch (type) {
                case 'INIT_TOPOLOGY':
                  // 初始拓扑数据
                  if (data.nodes) {
                    const wsAgents: Agent[] = data.nodes.map((node) => ({
                      id: node.id || node.node_id || '',
                      name: node.name,
                      group: node.group || 1,
                      lat: node.lat || 0,
                      lng: node.lng || 0,
                      online: true,
                      val: node.val,
                      tags: node.tags
                    }));
                    set({ agents: wsAgents });
                  }
                  if (data.links) {
                    const wsTasks: Task[] = data.links.map((link) => ({
                      id: `task-${Date.now()}-${Math.random()}`,
                      from: link.source,
                      to: link.target,
                      from_lat: 0, from_lng: 0, to_lat: 0, to_lng: 0 // 坐标在渲染时计算
                    }));
                    set({ tasks: wsTasks });
                  }
                  break;

                case 'DELTA_UPDATE':
                  if (data.nodes) {
                    const newAgents: Agent[] = data.nodes.map((n) => ({
                      id: n.id || n.node_id || '',
                      name: n.name,
                      group: n.group || 1,
                      online: true,
                      lat: n.lat || 0,
                      lng: n.lng || 0,
                      val: n.val,
                      tags: n.tags
                    }));
                    set(state => ({
                      agents: [...state.agents, ...newAgents]
                    }));
                    newAgents.forEach((agent) => {
                      get().addAlert({
                        id: Date.now() + Math.random(),
                        message: `New agent detected: ${agent.name}`,
                        level: 'low',
                        time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      });
                      get().addFeed({
                        kind: 'agent',
                        who: agent.name || agent.id,
                        sub: 'joined',
                      });
                    });
                  }
                  if (data.links) {
                    set(state => ({
                      tasks: [...state.tasks, ...data.links!.map((l) => ({
                        id: `task-${Date.now()}-${Math.random()}`,
                        from: l.source,
                        to: l.target,
                        from_lat: 0, from_lng: 0, to_lat: 0, to_lng: 0
                      }))].slice(-5)
                    }));
                  }
                  break;

                case 'LOG_MESSAGE': {
                  // 日志消息
                  const now = new Date();
                  const timeString = now.toLocaleTimeString('en-US', {
                    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
                  });
                  
                  let logMsg = '';
                  if (logType === 'p2p') {
                    const sender = data.sender_id?.slice(0, 8) || 'unknown';
                    const recipient = data.recipient_id?.slice(0, 8) || 'unknown';
                    logMsg = `[P2P] ${sender} -> ${recipient}: ${data.content}`;
                  } else {
                    logMsg = `[CHN] ${data.tags?.join(',') || 'general'}: ${data.content}`;
                  }

                  get().addLog({
                    id: `${Date.now()}-${Math.random()}`,
                    message: logMsg,
                    time: timeString,
                    type: logType as 'p2p' | 'channel'
                  });

                  if (logType === 'channel') {
                    get().addFeed({
                      kind: 'broadcast',
                      who: data.sender_id?.slice(0, 8) || 'unknown',
                      content: data.content,
                      time: timeString,
                    });
                  } else if (logType === 'p2p') {
                    get().addFeed({
                      kind: 'p2p',
                      who: `${(data.sender_id || '?').slice(0, 6)}→${(data.recipient_id || '?').slice(0, 6)}`,
                      content: data.content,
                      time: timeString,
                    });
                  }
                  break;
                }

                case 'AGENT_STATUS': {
                  const isOnline = data.status === 'online';
                  const knownAgent = get().agents.find(a => a.id === data.agent_id);
                  const agentName = knownAgent?.name || data.agent_name || data.agent_id;
                  get().addAlert({
                    id: Date.now() + Math.random(),
                    message: `${data.agent_name} ${isOnline ? 'connected' : 'disconnected'}`,
                    level: isOnline ? 'info' : 'medium',
                    time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  });
                  get().addFeed({
                    kind: 'agent',
                    who: agentName,
                    sub: isOnline ? 'joined' : 'left',
                  });
                  if (!isOnline) {
                    set(state => ({
                      agents: state.agents.map(a =>
                        a.id === data.agent_id ? { ...a, online: false } : a
                      )
                    }));
                  }
                  break;
                }
              }
            },
            (connected) => set({ isConnected: connected }),
            getToken() || undefined
          );
          wsManager.connect();
        }

        // 3. 启动日志 Ticker
        get().startTicker();

      } catch (error) {
        console.error('Failed to initialize XClaw Store:', error);
      }
    },

    destroy: () => {
      if (wsManager) {
        wsManager.disconnect();
        wsManager = null;
      }
      get().stopTicker();
    },

    // 添加日志
    addLog: (log: Log) => {
      messageBuffer.push(log);
    },

    // 清空日志
    clearLogs: () => {
      messageBuffer.length = 0;
      set({ logs: [] });
    },

    // 启动定时器
    startTicker: () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(() => {
        if (messageBuffer.length > 0) {
          const logsToAdd = [...messageBuffer];
          messageBuffer.length = 0;
          set((state) => ({
            logs: [...logsToAdd, ...state.logs].slice(0, MAX_LOGS)
          }));
        }
      }, 200);
    },

    // 停止定时器
    stopTicker: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    
    // 添加警报
    addAlert: (alert: Alert) => {
      set((state) => ({
        alerts: [alert, ...state.alerts].slice(0, 50)
      }));
    },
    
    // 清空警报
    clearAlerts: () => {
      set({ alerts: [] });
    },

    // 添加实时动态
    addFeed: (item) => {
      const time = item.time || new Date().toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      set(state => ({
        feed: [
          { ...item, time, id: `${Date.now()}-${Math.random()}` },
          ...state.feed,
        ].slice(0, 100),
      }));
    },

    // 清空实时动态
    clearFeed: () => {
      set({ feed: [] });
    },
    
    // 设置 Agent 分组
    setAgentGroups: (groups: AgentGroup[]) => {
      set({ agentGroups: groups });
    },
    
    // 设置 Agent 节点
    setAgents: (agents: Agent[]) => {
      set({ agents });
    },

    setSelectedAgentId: (id: string | null) => {
      set({ selectedAgentId: id });
    },
    
    // 设置任务
    setTasks: (tasks: Task[]) => {
      set({ tasks });
    },
    
    // 设置连接状态
    setIsConnected: (connected: boolean) => {
      set({ isConnected: connected });
    },
    
    // 设置 TPS
    setTps: (tps: number) => {
      set({ tps });
    },
    
    // 设置网络延迟
    setNetworkLatency: (latency: number) => {
      set({ networkLatency: latency });
    },

    // ===== Galaxy View Actions =====
    setGalaxyNodes: (nodes: GalaxyNode[]) => {
      set({ galaxyNodes: nodes });
    },
    setGalaxyEdges: (edges: GalaxyEdge[]) => {
      set({ galaxyEdges: edges });
    },
    setGalaxySelectedNode: (id: string | null) => {
      set({ galaxySelectedNode: id });
    },
    setGalaxyHoveredNode: (id: string | null) => {
      set({ galaxyHoveredNode: id });
    },
    setGalaxyCameraPosition: (pos: [number, number, number]) => {
      set({ galaxyCameraPosition: pos });
    },
    setGalaxyLayout: (layout: GalaxyLayout) => {
      set({ galaxyLayout: layout });
    },
    setGalaxyFilter: (filter: GalaxyFilter) => {
      set({ galaxyFilter: filter });
    },
    setGalaxyTimeRange: (range: GalaxyTimeRange) => {
      set({ galaxyTimeRange: range });
    },
    fetchGalaxyData: async () => {
      try {
        const data = await getTopology3D(get().galaxyTimeRange);
        if (data?.nodes) {
          set({ galaxyNodes: data.nodes.map(normalizeGalaxyNode) });
        }
        if (data?.edges) {
          set({
            galaxyEdges: data.edges.map(e => ({
              source: String(e.source),
              target: String(e.target),
              weight: Number(e.weight || 1),
            })),
          });
        }
      } catch (error) {
        console.error('Failed to fetch galaxy data:', error);
      }
    },
  };
});

// 导出类型
export type { XClawState };
