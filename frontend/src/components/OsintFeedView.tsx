import { useState, useMemo, useCallback } from 'react';
import { DeckGL } from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { FlyToInterpolator } from '@deck.gl/core';
import { Map as StaticMap } from '@vis.gl/react-maplibre';
import { useXClawStore } from '../store/useXClawStore';
import type { PickingInfo, MapViewState } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';

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

const cyberpunkColors = [
  [6, 182, 212],
  [239, 68, 68],
  [168, 85, 247],
  [245, 158, 11]
];

const EVENT_TYPE_CONFIG: Record<string, { color: [number, number, number]; label: string; icon: string }> = {
  p2p: { color: [6, 212, 255], label: 'P2P', icon: '↔' },
  channel: { color: [168, 85, 247], label: 'CHN', icon: '📡' },
  broadcast: { color: [245, 158, 11], label: 'BCAST', icon: '📢' },
  heartbeat: { color: [34, 197, 94], label: 'HB', icon: '💓' },
  agent_status: { color: [239, 68, 68], label: 'STATUS', icon: '●' },
  task_event: { color: [14, 165, 233], label: 'TASK', icon: '⚡' },
  alert: { color: [236, 72, 153], label: 'ALERT', icon: '⚠' },
  default: { color: [148, 163, 184], label: 'LOG', icon: '◉' },
};

interface EventMarker {
  id: string;
  position: [number, number];
  color: Uint8Array;
  radius: number;
  eventType: string;
  message: string;
  time: string;
  agentName?: string;
}

export default function OsintFeedView() {
  const [activeTab, setActiveTab] = useState('WORLD');
  const [flyTo, setFlyTo] = useState<FlyToTarget | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<EventMarker | null>(null);
  const [userViewState, setUserViewState] = useState<MapViewState>({
    longitude: 0,
    latitude: 20,
    zoom: 1.5,
    pitch: 45,
    bearing: 0,
  });
  const [filterType, setFilterType] = useState<string>('all');

  const agents = useXClawStore(state => state.agents);
  const logs = useXClawStore(state => state.logs);
  const alerts = useXClawStore(state => state.alerts);

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

  const agentList = useMemo(() => Array.from(agentMap.values()), [agentMap]);

  const allEvents = useMemo<EventMarker[]>(() => {
    const events: EventMarker[] = [];
    let agentIndex = 0;

    const pickAgent = () => {
      if (agentList.length === 0) return null;
      const agent = agentList[agentIndex % agentList.length];
      agentIndex++;
      return agent;
    };

    logs.forEach(log => {
      const config = EVENT_TYPE_CONFIG[log.type] || EVENT_TYPE_CONFIG.default;
      const agentId = extractAgentId(log.message);
      const agent = agentId ? agentMap.get(agentId) : pickAgent();
      if (!agent) return;

      let eventType = log.type;
      if (log.type === 'p2p') eventType = 'p2p';
      else if (log.type === 'channel') eventType = 'channel';

      events.push({
        id: log.id,
        position: [agent.lng, agent.lat],
        color: new Uint8Array([...config.color, 230]),
        radius: 10,
        eventType,
        message: log.message,
        time: log.time,
        agentName: agent.name,
      });
    });

    alerts.forEach(alert => {
      const config = EVENT_TYPE_CONFIG['alert'];
      const agent = pickAgent();
      if (!agent) return;
      events.push({
        id: `alert-${alert.id}`,
        position: [agent.lng, agent.lat],
        color: new Uint8Array([...config.color, 240]),
        radius: 12,
        eventType: 'alert',
        message: alert.message,
        time: alert.time,
        agentName: agent.name,
      });
    });

    return events.reverse();
  }, [logs, alerts, agentMap, agentList]);

  const filteredEvents = useMemo(() => {
    if (filterType === 'all') return allEvents;
    return allEvents.filter(e => e.eventType === filterType);
  }, [allEvents, filterType]);

  const nodeData = useMemo(() => {
    return agents.map(agent => {
      const baseColor = cyberpunkColors[agent.group % cyberpunkColors.length];
      return {
        position: [agent.lng, agent.lat] as [number, number],
        color: new Uint8Array([...baseColor, 80]) as Uint8Array,
        radius: 4,
        name: agent.name,
        group: agent.group,
        online: agent.online,
      };
    });
  }, [agents]);

  const layers = useMemo(() => [
    new ScatterplotLayer({
      id: 'osint-bg-nodes',
      data: nodeData,
      getPosition: (d: typeof nodeData[number]) => d.position,
      getFillColor: (d: typeof nodeData[number]) => d.color,
      getRadius: (d: typeof nodeData[number]) => d.radius,
      radiusMinPixels: 2,
      radiusMaxPixels: 6,
      opacity: 0.5,
      stroked: false,
    }),
    new ScatterplotLayer<EventMarker>({
      id: 'osint-events',
      data: filteredEvents,
      getPosition: d => d.position,
      getFillColor: d => d.id === selectedEvent?.id
        ? new Uint8Array([255, 255, 255, 255])
        : d.color,
      getRadius: d => d.id === selectedEvent?.id ? d.radius + 4 : d.radius,
      radiusMinPixels: 4,
      radiusMaxPixels: 16,
      opacity: 0.9,
      stroked: true,
      lineWidthMinPixels: 1.5,
      getLineColor: d => d.id === selectedEvent?.id
        ? new Uint8Array([255, 255, 255, 200])
        : new Uint8Array([255, 255, 255, 60]),
      pickable: true,
      onClick: info => {
        const obj = info.object as unknown as EventMarker | null;
        if (obj) {
          setSelectedEvent(obj.id === selectedEvent?.id ? null : obj);
        } else {
          setSelectedEvent(null);
        }
      },
    }),
  ], [nodeData, filteredEvents, selectedEvent]);

  const stats = useMemo(() => ({
    total: allEvents.length,
    filtered: filteredEvents.length,
    p2p: allEvents.filter(e => e.eventType === 'p2p').length,
    chn: allEvents.filter(e => e.eventType === 'channel').length,
    alert: allEvents.filter(e => e.eventType === 'alert').length,
  }), [allEvents, filteredEvents]);

  const filterOptions = ['all', 'p2p', 'channel', 'alert'];

  return (
    <div className="w-full h-full relative bg-[#0B0F19]">
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-[#0B0F19] to-transparent pb-16">
        <div className="overflow-x-auto overflow-y-hidden scrollbar-hide px-4 pt-4 pb-2">
          <div className="flex space-x-2 md:space-x-4 min-w-max mb-2">
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
          <div className="flex space-x-1.5 md:space-x-2 min-w-max items-center">
            <span className="text-[9px] text-gray-600 font-mono mr-1">FILTER:</span>
            {filterOptions.map(ft => {
              const cfg = EVENT_TYPE_CONFIG[ft] || { label: ft.toUpperCase(), color: [148, 163, 184] };
              const count = ft === 'all' ? stats.total :
                ft === 'p2p' ? stats.p2p :
                ft === 'channel' ? stats.chn : stats.alert;
              return (
                <button
                  key={ft}
                  className={`px-2 py-0.5 border text-[9px] md:text-[10px] font-mono whitespace-nowrap transition-all ${
                    filterType === ft
                      ? 'border-cyan-400 bg-cyan-900/20 text-cyan-400'
                      : 'border-gray-700/50 bg-gray-900/20 text-gray-500 hover:border-gray-600'
                  }`}
                  onClick={() => setFilterType(ft)}
                >
                  {cfg.label} ({count})
                </button>
              );
            })}
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
            pitch: v.pitch ?? 0,
            bearing: v.bearing ?? 0,
          });
          if (flyTo) setFlyTo(null);
        }}
        layers={layers}
        style={{ width: '100%', height: '100%' }}
        useDevicePixels={false}
        getTooltip={(info: PickingInfo) => {
          const obj = info.object as unknown as EventMarker | null;
          if (!obj) return null;
          const cfg = EVENT_TYPE_CONFIG[obj.eventType] || EVENT_TYPE_CONFIG.default;
          return {
            html: `<div class="p-2 bg-slate-900 border border-slate-600 text-gray-300 text-xs font-mono rounded max-w-[280px]">
              <div class="font-bold mb-1" style="color:rgb(${cfg.color.join(',')})">${cfg.icon} ${cfg.label}</div>
              <div class="text-gray-400 truncate">${obj.message}</div>
              <div class="text-gray-600 mt-1">${obj.time}</div>
            </div>`
          };
        }}
      >
        <StaticMap style={{ width: '100%', height: '100%' }} mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
      </DeckGL>

      <div className="absolute bottom-2 left-2 right-2 md:left-4 md:right-80 z-20">
        <div className="bg-slate-900/90 border border-slate-700/50 rounded max-h-[180px] overflow-hidden backdrop-blur-sm">
          <div className="flex items-center justify-between px-2 py-1 border-b border-slate-800/50 bg-slate-800/50">
            <span className="text-[9px] font-mono text-gray-400">OSINT STREAM · {filteredEvents.length} EVENTS</span>
            <span className="text-[8px] font-mono text-gray-600">{new Date().toLocaleTimeString()}</span>
          </div>
          <div className="overflow-y-auto max-h-[150px] scrollbar-thin">
            {filteredEvents.length === 0 && (
              <div className="px-3 py-4 text-[10px] font-mono text-gray-600 text-center">NO SIGNALS</div>
            )}
            {filteredEvents.slice(0, 20).map(evt => {
              const cfg = EVENT_TYPE_CONFIG[evt.eventType] || EVENT_TYPE_CONFIG.default;
              const isSelected = evt.id === selectedEvent?.id;
              return (
                <div
                  key={evt.id}
                  className={`flex items-start gap-2 px-2 py-1 border-b border-slate-800/30 cursor-pointer transition-colors ${
                    isSelected ? 'bg-cyan-900/20 border-l-2 border-l-cyan-400' : 'hover:bg-slate-800/40'
                  }`}
                  onClick={() => setSelectedEvent(isSelected ? null : evt)}
                >
                  <span className="text-[10px] mt-0.5 shrink-0" style={{ color: `rgb(${cfg.color.join(',')})` }}>{cfg.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[10px] font-mono truncate ${isSelected ? 'text-cyan-300' : 'text-gray-400'}`}>{evt.message}</div>
                    <div className="text-[8px] font-mono text-gray-600 mt-0.5">{evt.time}{evt.agentName ? ` · ${evt.agentName}` : ''}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {selectedEvent && (
        <div className="absolute top-3 right-3 z-30 w-64 bg-slate-900/95 border border-slate-600/60 rounded-lg shadow-lg shadow-black/20 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              {(() => {
                const cfg = EVENT_TYPE_CONFIG[selectedEvent.eventType] || EVENT_TYPE_CONFIG.default;
                return (
                  <>
                    <span style={{ color: `rgb(${cfg.color.join(',')})` }}>{cfg.icon}</span>
                    <span className="text-[10px] font-bold font-mono" style={{ color: `rgb(${cfg.color.join(',')})` }}>{cfg.label}</span>
                  </>
                );
              })()}
            </div>
            <button onClick={() => setSelectedEvent(null)} className="text-gray-600 hover:text-gray-400 text-sm leading-none">✕</button>
          </div>
          <div className="text-[11px] font-mono text-gray-300 break-all leading-relaxed">{selectedEvent.message}</div>
          <div className="mt-2 pt-1.5 border-t border-slate-800/50 flex justify-between text-[9px] font-mono text-gray-500">
            <span>{selectedEvent.time}</span>
            {selectedEvent.agentName && <span>{selectedEvent.agentName}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function extractAgentId(message: string): string | null {
  const match = message.match(/\[([a-f0-9-]{8,36})\]/);
  return match ? match[1] : null;
}