import { useState, useMemo, useCallback } from 'react';
import { DeckGL } from '@deck.gl/react';
import { ArcLayer, ScatterplotLayer } from '@deck.gl/layers';
import { FlyToInterpolator } from '@deck.gl/core';
import { Map as StaticMap } from '@vis.gl/react-maplibre';
import { useXClawStore } from '../store/useXClawStore';
import type { PickingInfo, MapViewState } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fetchGlobalStats } from '../utils/api';

interface FlyToTarget {
  longitude: number;
  latitude: number;
  zoom: number;
}

const CONTINENTS: Record<string, FlyToTarget> = {
  WORLD: { longitude: 0, latitude: 20, zoom: 1.5 },
  NORTH_AMERICA: { longitude: -100, latitude: 45, zoom: 3 },
  SOUTH_AMERICA: { longitude: -60, latitude: -15, zoom: 3 },
  EUROPE: { longitude: 15, latitude: 50, zoom: 3.5 },
  AFRICA: { longitude: 20, latitude: 5, zoom: 3 },
  ASIA: { longitude: 90, latitude: 35, zoom: 2.5 },
  OCEANIA: { longitude: 135, latitude: -25, zoom: 3.5 },
};

const GROUP_COLORS: Record<number, [number, number, number]> = {
  1: [239, 68, 68],
  2: [16, 185, 129],
  3: [14, 165, 233],
  4: [245, 158, 11],
  5: [139, 92, 246],
  6: [236, 72, 153],
  7: [20, 184, 166],
  8: [249, 115, 22],
  9: [59, 130, 246],
  10: [99, 102, 241],
  11: [132, 204, 22],
  12: [236, 72, 153],
};

const ARC_COLOR = new Uint8Array([6, 182, 212, 160]);
const ARC_HOVER_COLOR = new Uint8Array([6, 212, 255, 240]);

interface TaskArcData {
  id: string;
  sourcePosition: [number, number];
  targetPosition: [number, number];
  sourceName: string;
  targetName: string;
  color: Uint8Array;
  width: number;
}

interface NodeData {
  position: [number, number];
  color: Uint8Array;
  radius: number;
  name: string;
  group: number;
  online: boolean;
}

export default function TopologyView() {
  const [activeTab, setActiveTab] = useState('WORLD');
  const [flyTo, setFlyTo] = useState<FlyToTarget | null>(null);
  const [hoveredTask, setHoveredTask] = useState<TaskArcData | null>(null);
  const [userViewState, setUserViewState] = useState<MapViewState>({
    longitude: 0,
    latitude: 20,
    zoom: 1.5,
    pitch: 45,
    bearing: 0,
  });

  const agents = useXClawStore(state => state.agents);
  const tasks = useXClawStore(state => state.tasks);

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    setFlyTo(CONTINENTS[tab]);
  }, []);

  const viewState = useMemo<MapViewState>(() => {
    if (!flyTo) return userViewState;
    return {
      ...userViewState,
      longitude: flyTo.longitude,
      latitude: flyTo.latitude,
      zoom: flyTo.zoom,
      transitionDuration: 1500,
      transitionInterpolator: new FlyToInterpolator(),
    };
  }, [flyTo, userViewState]);

  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string; lng: number; lat: number; group: number; online: boolean }>();
    agents.forEach(a => map.set(a.id || a.name, { name: a.name, lng: a.lng, lat: a.lat, group: a.group, online: a.online }));
    return map;
  }, [agents]);

  const taskArcs = useMemo<TaskArcData[]>(() => {
    const arcs: TaskArcData[] = [];
    for (const task of tasks) {
      const src = agentMap.get(task.from || '') || agentMap.get(task.source || '');
      const tgt = agentMap.get(task.to || '') || agentMap.get(task.target || '');
      if (!src || !tgt) continue;
      arcs.push({
        id: task.id,
        sourcePosition: [src.lng, src.lat],
        targetPosition: [tgt.lng, tgt.lat],
        sourceName: src.name,
        targetName: tgt.name,
        color: ARC_COLOR,
        width: 2,
      });
    }
    return arcs;
  }, [tasks, agentMap]);

  const nodeData = useMemo<NodeData[]>(() => {
    return agents.map(agent => {
      const baseColor = GROUP_COLORS[agent.group] || GROUP_COLORS[1];
      return {
        position: [agent.lng, agent.lat] as [number, number],
        color: new Uint8Array([...baseColor, agent.online ? 220 : 100]),
        radius: agent.online ? 5 : 3,
        name: agent.name,
        group: agent.group,
        online: agent.online,
      };
    });
  }, [agents]);

  const layers = useMemo(() => [
    new ArcLayer<TaskArcData>({
      id: 'topology-arcs',
      data: taskArcs,
      getSourcePosition: d => d.sourcePosition,
      getTargetPosition: d => d.targetPosition,
      getSourceColor: d => d === hoveredTask ? ARC_HOVER_COLOR : d.color,
      getTargetColor: d => d === hoveredTask ? ARC_HOVER_COLOR : d.color,
      getWidth: d => d.width,
      opacity: 0.85,
      pickable: true,
      onHover: info => setHoveredTask((info.object ?? null) as TaskArcData | null),
      getTilt: 0.3,
    }),
    new ScatterplotLayer<NodeData>({
      id: 'topology-nodes',
      data: nodeData,
      getPosition: (d: NodeData) => d.position,
      getFillColor: (d: NodeData) => d.color,
      getRadius: (d: NodeData) => d.radius,
      radiusMinPixels: 3,
      radiusMaxPixels: 10,
      opacity: 1,
      stroked: true,
      lineWidthMinPixels: 1,
      getLineColor: () => new Uint8Array([255, 255, 255, 80]),
      pickable: true,
    }),
  ], [taskArcs, nodeData, hoveredTask]);

  const [globalStats, setGlobalStats] = useState<{ memory: Record<string, unknown>; relationships: Record<string, unknown>; agents: { online_agents: number } } | null>(null);

  // Fetch global stats periodically
  useState(() => {
    const fetchStats = async () => {
      try {
        const res = await fetchGlobalStats() as { success: boolean; data: { memory: Record<string, unknown>; relationships: Record<string, unknown>; agents: { online_agents: number } } };
        if (res.success) setGlobalStats(res.data);
      } catch { /* ignore */ }
    };
    fetchStats();
    const id = setInterval(fetchStats, 30000);
    return () => clearInterval(id);
  });

  const stats = useMemo(() => ({
    validArcs: taskArcs.length,
    activeAgents: agents.filter(a => a.online).length,
    totalAgents: agents.length,
    globalOnline: globalStats?.agents?.online_agents ?? 0,
  }), [taskArcs, agents, globalStats]);

  return (
    <div className="w-full h-full relative bg-[#0B0F19]">
      {agents.length === 0 && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0B0F19]">
          <div className="text-center">
            <div className="text-gray-500 text-xs font-mono mb-2">AWAITING TOPOLOGY DATA</div>
            <div className="text-gray-600 text-[10px] font-mono">Waiting for WebSocket feed...</div>
          </div>
        </div>
      )}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-[#0B0F19] to-transparent pb-8">
        <div className="overflow-x-auto overflow-y-hidden scrollbar-hide p-4">
          <div className="flex space-x-2 md:space-x-4 min-w-max">
            {Object.keys(CONTINENTS).map(tab => (
              <button
                key={tab}
                className={`px-3 py-1 md:px-4 border text-[10px] md:text-xs font-semibold whitespace-nowrap transition-all ${
                  activeTab === tab
                    ? 'border-cyan-400 bg-cyan-900/30 text-cyan-400'
                    : 'border-gray-600 bg-gray-900/30 text-gray-400 hover:border-gray-500'
                }`}
                onClick={() => handleTabChange(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
      </div>

      <DeckGL
        viewState={viewState}
        controller={true}
        onViewStateChange={({ viewState: vs }) => {
          const v = vs as MapViewState;
          setUserViewState({
            longitude: v.longitude,
            latitude: v.latitude,
            zoom: v.zoom,
            pitch: v.pitch,
            bearing: v.bearing,
          });
          if (flyTo) setFlyTo(null);
        }}
        layers={layers}
        style={{ width: '100%', height: '100%' }}
        useDevicePixels={false}
        getTooltip={(info: PickingInfo) => {
          const obj = info.object as unknown as TaskArcData;
          if (!obj) return null;
          return {
            html: `<div class="p-2 bg-slate-900 border border-cyan-500 text-cyan-400 text-xs font-mono rounded"><div class="font-bold text-cyan-300 mb-1">ROUTE</div><div>${obj.sourceName} → ${obj.targetName}</div></div>`
          };
        }}
      >
        <StaticMap style={{ width: '100%', height: '100%' }} mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
      </DeckGL>

      <div className="absolute bottom-2 md:bottom-4 left-2 md:left-4 z-20 flex flex-col gap-1">
        <div className="bg-slate-900/80 border border-cyan-500/30 p-1.5 md:p-2 rounded text-[8px] md:text-[9px] font-mono text-cyan-300 space-y-0.5">
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <span>ROUTES: <b style={{ color: '#22d3ee' }}>{stats.validArcs}</b></span>
            <span>AGENTS: <b style={{ color: '#22c55e' }}>{stats.activeAgents}/{stats.totalAgents}</b></span>
            <span>GLOBAL: <b style={{ color: '#a78bfa' }}>{stats.globalOnline}</b></span>
          </div>
        </div>
      </div>

      {hoveredTask && (
        <div className="absolute top-3 right-3 z-30 w-64 bg-slate-900/95 border border-cyan-500/60 rounded-lg shadow-lg shadow-cyan-500/10 p-3">
          <div className="text-[10px] font-mono text-cyan-400 space-y-1">
            <div className="font-bold border-b border-cyan-800/50 pb-1">TASK ROUTE</div>
            <div><span className="text-gray-500">FROM:</span> <span className="text-cyan-300">{hoveredTask.sourceName}</span></div>
            <div><span className="text-gray-500">TO:</span> <span className="text-cyan-300">{hoveredTask.targetName}</span></div>
            <div><span className="text-gray-500">ID:</span> <span className="text-gray-400">{hoveredTask.id.slice(0, 16)}...</span></div>
          </div>
        </div>
      )}
    </div>
  );
}