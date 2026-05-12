import { useState, useEffect, useMemo, useCallback } from 'react';
import { DeckGL } from '@deck.gl/react';
import { ScatterplotLayer, LineLayer } from '@deck.gl/layers';
import { FlyToInterpolator } from '@deck.gl/core';
import { Map as StaticMap } from '@vis.gl/react-maplibre';
import { useXClawStore } from '../store/useXClawStore';
import { fetchAgentDetail, fetchAgentSkills, fetchAgentProfile } from '../utils/api';
import 'maplibre-gl/dist/maplibre-gl.css';

const cyberpunkColors = [
  [6, 182, 212],
  [239, 68, 68],
  [168, 85, 247],
  [245, 158, 11]
];

import type { PickingInfo } from '@deck.gl/core';

interface NodeData {
  id: string;
  name: string;
  position: [number, number];
  color: [number, number, number, number];
  radius: number;
  group: number;
}

interface AgentDetail {
  node_id: string;
  name: string;
  capabilities: string;
  tags: string[];
  status: string;
  last_heartbeat: string;
  endpoint_url: string;
  latitude: number;
  longitude: number;
  reputation_score: number;
}

interface SkillInfo {
  name: string;
  description: string;
  category: string;
  version: string;
}

interface AgentProfile {
  node_id: string;
  agent_name: string;
  description: string;
  reputation_score: number;
  total_earnings: number;
  latitude: number;
  longitude: number;
  created_at: string;
  task_stats: {
    total_tasks: string;
    completed_tasks: string;
    failed_tasks: string;
    pending_tasks: string;
  };
  memory_stats: { type: string; count: string }[] | null;
  relationships: { related_agent_id: string; related_name: string; type: string; interaction_count: number; avg_rating: number }[];
}

interface RelationshipLine {
  source: [number, number];
  target: [number, number];
  type: string;
  targetName: string;
}

interface MapViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

interface FlyToTarget {
  longitude: number;
  latitude: number;
  zoom: number;
}

interface WorldMapProps {
  flyTo?: FlyToTarget | null;
  onFlyComplete?: () => void;
}

import { runPrecisionTests } from '../utils/geoUtils';

export default function WorldMap({ flyTo, onFlyComplete }: WorldMapProps) {
  const agents = useXClawStore(state => state.agents);
  const setSelectedAgentId = useXClawStore(state => state.setSelectedAgentId);
  const [animationTime, setAnimationTime] = useState(0);
  const [debugMode, setDebugMode] = useState(false);
  const [userViewState, setUserViewState] = useState({
    longitude: 0,
    latitude: 20,
    zoom: 1.5,
    pitch: 45,
    bearing: 0
  });

  const [selectedNode, setSelectedNode] = useState<NodeData | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [relLines, setRelLines] = useState<RelationshipLine[]>([]);
  const [loading, setLoading] = useState(false);

  const handleNodeClick = useCallback((info: PickingInfo) => {
    const object = info.object as NodeData;
    if (!object) {
      setSelectedNode(null);
      setDetail(null);
      setSkills([]);
      setProfile(null);
      setRelLines([]);
      return;
    }
    if (selectedNode?.id === object.id) {
      setSelectedNode(null);
      setDetail(null);
      setSkills([]);
      setProfile(null);
      setRelLines([]);
      return;
    }
    setSelectedNode(object);
    setDetail(null);
    setSkills([]);
    setProfile(null);
    setRelLines([]);
    setLoading(true);
    Promise.all([
      fetchAgentDetail(object.id).catch(() => null),
      fetchAgentSkills(object.id).catch(() => null),
      fetchAgentProfile(object.id).catch(() => null)
    ]).then(([detailRes, skillsRes, profileRes]) => {
      if (detailRes?.success) setDetail(detailRes.data);
      if (skillsRes?.success) setSkills(skillsRes.data || []);
      if (profileRes?.success) {
        const p = profileRes.data as AgentProfile;
        setProfile(p);
        if (p.relationships?.length > 0) {
          const agentMap = new Map(agents.map(a => [a.id, a]));
          const lines: RelationshipLine[] = [];
          for (const rel of p.relationships) {
            const target = agentMap.get(rel.related_agent_id);
            if (target) {
              lines.push({
                source: object.position,
                target: [target.lng, target.lat],
                type: rel.type,
                targetName: rel.related_name || target.name
              });
            }
          }
          setRelLines(lines);
        }
      }
      setLoading(false);
    });
  }, [selectedNode, agents]);

  useEffect(() => {
    runPrecisionTests();
  }, []);

  const viewState = useMemo(() => {
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
  
  // 动画循环：使用 requestAnimationFrame 确保平滑
  useEffect(() => {
    let requestRef: number;
    const animate = (time: number) => {
      setAnimationTime(time / 1000); // 转换为秒
      requestRef = requestAnimationFrame(animate);
    };
    requestRef = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef);
  }, []);

  // 处理 Agent 数据并计算闪烁动画
  const nodeData = useMemo<NodeData[]>(() => {
    const coordCount = new Map<string, number>();
    return agents.map(agent => {
      const key = `${agent.lng},${agent.lat}`;
      const idx = coordCount.get(key) || 0;
      coordCount.set(key, idx + 1);
      const jitter = idx === 0 ? 0 : 0.02;
      const jitterLng = agent.lng + jitter * (idx % 2 === 0 ? 1 : -1) * (0.5 + (idx * 0.3) % 1);
      const jitterLat = agent.lat + jitter * (idx % 2 === 1 ? 1 : -1) * (0.5 + (idx * 0.7) % 1);
      const baseColor = cyberpunkColors[agent.group % cyberpunkColors.length];
      // 计算闪烁：正弦波动画，频率 2Hz
      const pulse = (Math.sin(animationTime * 4 + (parseFloat(agent.id.slice(-2)) || 0)) + 1) / 2;
      const opacity = 0.4 + pulse * 0.6; // 透明度在 0.4 到 1.0 之间波动
      
      return {
        id: agent.id,
        name: agent.name,
        position: [jitterLng, jitterLat],
        color: [baseColor[0], baseColor[1], baseColor[2], opacity * 255] as [number, number, number, number],
        radius: 4 + pulse * 2, // 半径在 4 到 6 之间波动
        group: agent.group
      };
    });
  }, [agents, animationTime]);
  
  const layers = useMemo(() => [
    new ScatterplotLayer<NodeData>({
      id: 'nodes',
      data: nodeData,
      getPosition: (d: NodeData) => d.position,
      getFillColor: (d: NodeData) => d.color,
      getRadius: (d: NodeData) => d.radius,
      updateTriggers: {
        getFillColor: [animationTime],
        getRadius: [animationTime]
      },
      radiusMinPixels: 2,
      radiusMaxPixels: 10,
      opacity: 1,
      stroked: true,
      lineWidthMinPixels: 1,
      getLineColor: () => [255, 255, 255, 100],
      pickable: true,
      onClick: handleNodeClick
    }),
    // Debug 辅助层：显示坐标转换和边界框
    ...(debugMode ? [
      new ScatterplotLayer<NodeData>({
        id: 'debug-nodes',
        data: nodeData,
        getPosition: (d: NodeData) => d.position,
        getFillColor: [255, 255, 255, 50],
        getRadius: 100000,
        stroked: true,
        lineWidthMinPixels: 1,
        getLineColor: [0, 255, 255, 200]
      })
    ] : []),
    ...(relLines.length > 0 ? [
      new LineLayer<RelationshipLine>({
        id: 'relationship-lines',
        data: relLines,
        getSourcePosition: (d: RelationshipLine) => d.source,
        getTargetPosition: (d: RelationshipLine) => d.target,
        getColor: (d: RelationshipLine) => d.type === 'trusted' ? [6, 182, 212, 180] : d.type === 'blocked' ? [239, 68, 68, 180] : [168, 85, 247, 120],
        getWidth: 2,
        pickable: true
      })
    ] : [])
  ], [nodeData, debugMode, animationTime, handleNodeClick, relLines]);
  
  return (
    <div className="w-full h-full relative">
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
          onFlyComplete?.();
        }}
        layers={layers}
        style={{ width: '100%', height: '100%' }}
        useDevicePixels={false}
        getTooltip={(info: PickingInfo) => {
          const object = info.object as NodeData;
          return object && {
            html: `<div class="p-2 bg-slate-900 border border-cyan-500 text-cyan-400 text-xs font-mono">
                    <div class="font-bold border-b border-cyan-800 mb-1 pb-1">${object.name}</div>
                    <div>ID: ${object.id}</div>
                    <div>LNG: ${object.position[0].toFixed(4)}</div>
                    <div>LAT: ${object.position[1].toFixed(4)}</div>
                  </div>`
          };
        }}
      >
        <StaticMap
          style={{ width: '100%', height: '100%' }}
          mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
        />
      </DeckGL>

      {/* 可视化调试工具 */}
      <div className="absolute bottom-2 md:bottom-4 left-2 md:left-4 z-20 flex flex-col gap-1 md:gap-2">
        <button 
          onClick={() => setDebugMode(!debugMode)}
          className={`px-2 md:px-3 py-0.5 md:py-1 rounded text-[9px] md:text-[10px] font-mono border transition-all whitespace-nowrap ${
            debugMode 
              ? 'bg-cyan-500/20 border-cyan-400 text-cyan-400' 
              : 'bg-slate-800 border-slate-700 text-gray-400'
          }`}
        >
          {debugMode ? 'DISABLE DEBUG' : 'ENABLE DEBUG'}
        </button>
        {debugMode && (
          <div className="bg-slate-900/80 border border-cyan-500/30 p-1.5 md:p-2 rounded text-[8px] md:text-[9px] font-mono text-cyan-300">
            <div>AGENTS: {agents.length}</div>
            <div>TIME: {animationTime.toFixed(2)}s</div>
            <div>FPS: 60 (RAF)</div>
            <div className="mt-0.5 md:mt-1 border-t border-cyan-900 pt-0.5 md:pt-1">
              PROJECTION: Web Mercator
            </div>
          </div>
        )}
      </div>

      {selectedNode && (
        <div className="absolute top-3 right-3 z-30 w-72 md:w-80">
          <div className="bg-slate-900/95 border border-cyan-500/60 rounded-lg shadow-lg shadow-cyan-500/10 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-cyan-500/10 border-b border-cyan-800/50">
              <span className="text-cyan-400 font-bold text-xs font-mono truncate">{selectedNode.name}</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setSelectedAgentId(selectedNode.id)}
                  className="text-[10px] px-1.5 py-0.5 bg-cyan-500/20 border border-cyan-700/50 rounded hover:bg-cyan-500/30 text-cyan-300"
                >MSG</button>
                <button
                  onClick={() => { setSelectedNode(null); setDetail(null); setSkills([]); setProfile(null); setRelLines([]); }}
                  className="text-cyan-600 hover:text-cyan-400 text-sm leading-none"
                >✕</button>
              </div>
            </div>
            <div className="p-3 text-[11px] font-mono text-cyan-300 space-y-1.5 max-h-[60vh] overflow-y-auto">
              <div className="text-gray-500">ID: <span className="text-cyan-400">{selectedNode.id}</span></div>
              <div className="text-gray-500">LNG: <span className="text-cyan-400">{selectedNode.position[0].toFixed(4)}</span>  LAT: <span className="text-cyan-400">{selectedNode.position[1].toFixed(4)}</span></div>

              {loading && <div className="text-cyan-500 animate-pulse pt-1">Loading...</div>}

              {detail && (<>
                <div className="border-t border-cyan-900/50 pt-1.5 mt-1.5">
                  <span className="text-gray-500">Status: </span>
                  <span className={detail.status === 'online' ? 'text-green-400' : 'text-red-400'}>{detail.status}</span>
                </div>
                {detail.last_heartbeat && (
                  <div className="text-gray-500">Last Heartbeat: <span className="text-cyan-400">{new Date(detail.last_heartbeat).toLocaleString()}</span></div>
                )}
                {detail.capabilities && (
                  <div className="border-t border-cyan-900/50 pt-1.5 mt-1.5">
                    <div className="text-gray-500 mb-1">Capabilities:</div>
                    <div className="text-cyan-400 break-all">{detail.capabilities}</div>
                  </div>
                )}
                {detail.tags && detail.tags.length > 0 && (
                  <div className="border-t border-cyan-900/50 pt-1.5 mt-1.5">
                    <div className="text-gray-500 mb-1">Tags:</div>
                    <div className="flex flex-wrap gap-1">
                      {detail.tags.map((tag, i) => (
                        <span key={i} className="px-1.5 py-0.5 bg-cyan-500/10 border border-cyan-800/50 rounded text-[10px] text-cyan-400">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {detail.endpoint_url && (
                  <div className="text-gray-500">Endpoint: <span className="text-cyan-400 break-all">{detail.endpoint_url}</span></div>
                )}
                {detail.reputation_score != null && (
                  <div className="text-gray-500">Reputation: <span className="text-cyan-400">{detail.reputation_score}</span></div>
                )}
              </>)}

              {profile && (<>
                <div className="border-t border-cyan-900/50 pt-1.5 mt-1.5">
                  <div className="text-gray-500 mb-1">Task Stats:</div>
                  <div className="grid grid-cols-2 gap-1">
                    <span className="text-cyan-400">{profile.task_stats?.completed_tasks || 0}<span className="text-gray-600"> done</span></span>
                    <span className="text-red-400">{profile.task_stats?.failed_tasks || 0}<span className="text-gray-600"> fail</span></span>
                    <span className="text-yellow-400">{profile.task_stats?.pending_tasks || 0}<span className="text-gray-600"> pend</span></span>
                    <span className="text-gray-400">{profile.task_stats?.total_tasks || 0}<span className="text-gray-600"> total</span></span>
                  </div>
                </div>
                {profile.memory_stats && profile.memory_stats.length > 0 && (
                  <div className="border-t border-cyan-900/50 pt-1.5 mt-1.5">
                    <div className="text-gray-500 mb-1">Memories:</div>
                    <div className="flex flex-wrap gap-1">
                      {profile.memory_stats.map((m, i) => (
                        <span key={i} className="px-1.5 py-0.5 bg-purple-500/10 border border-purple-800/50 rounded text-[10px] text-purple-400">{m.type}: {m.count}</span>
                      ))}
                    </div>
                  </div>
                )}
                {profile.relationships && profile.relationships.length > 0 && (
                  <div className="border-t border-cyan-900/50 pt-1.5 mt-1.5">
                    <div className="text-gray-500 mb-1">Relationships ({profile.relationships.length}):</div>
                    <div className="space-y-1">
                      {profile.relationships.map((r, i) => (
                        <div key={i} className="flex items-center justify-between bg-slate-800/60 border border-cyan-900/40 rounded px-2 py-0.5">
                          <span className="text-cyan-400 text-[10px]">{r.related_name || r.related_agent_id.slice(0, 8)}</span>
                          <span className={`text-[10px] px-1 rounded ${r.type === 'trusted' ? 'text-green-400 bg-green-500/10' : r.type === 'blocked' ? 'text-red-400 bg-red-500/10' : 'text-gray-400 bg-gray-500/10'}`}>{r.type}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>)}

              {skills.length > 0 && (
                <div className="border-t border-cyan-900/50 pt-1.5 mt-1.5">
                  <div className="text-gray-500 mb-1">Skills ({skills.length}):</div>
                  <div className="space-y-1.5">
                    {skills.map((s, i) => (
                      <div key={i} className="bg-slate-800/60 border border-cyan-900/40 rounded px-2 py-1">
                        <div className="text-cyan-400 font-bold">{s.name} <span className="text-gray-600 font-normal">v{s.version}</span></div>
                        <div className="text-gray-400 text-[10px]">{s.description}</div>
                        <div className="text-cyan-700 text-[10px]">{s.category}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
