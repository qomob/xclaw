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
                  break;
                }

                case 'AGENT_STATUS': {
                  const isOnline = data.status === 'online';
                  get().addAlert({
                    id: Date.now() + Math.random(),
                    message: `${data.agent_name} ${isOnline ? 'connected' : 'disconnected'}`,
                    level: isOnline ? 'info' : 'medium',
                    time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
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
          set({ galaxyNodes: data.nodes });
        }
        if (data?.edges) {
          set({ galaxyEdges: data.edges });
        }
      } catch (error) {
        console.error('Failed to fetch galaxy data:', error);
      }
    },
  };
});

// 导出类型
export type { XClawState };
