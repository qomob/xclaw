import React, { useState, useCallback } from 'react';
import WorldMap from './WorldMap';
import { useXClawStore } from '../store/useXClawStore';

interface FlyToTarget {
  longitude: number;
  latitude: number;
  zoom: number;
}

interface NetworkMapProps {
  showEvents?: boolean;
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

export default function NetworkMap({ showEvents = false }: NetworkMapProps) {
  const [activeTab, setActiveTab] = useState('WORLD');
  const [flyTo, setFlyTo] = useState<FlyToTarget | null>(null);
  
  const agents = useXClawStore(state => state.agents);
  const tasks = useXClawStore(state => state.tasks);
  
  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    setFlyTo(CONTINENTS[tab]);
  }, []);
  
  const tabs = Object.keys(CONTINENTS);
  
  return (
    <div className="w-full h-full relative bg-[#0B0F19]">
      {/* 顶部导航区 - 响应式 */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-[#0B0F19] to-transparent pb-8">
        <div className="overflow-x-auto overflow-y-hidden scrollbar-hide p-4">
          <div className="flex space-x-2 md:space-x-4 min-w-max">
            {tabs.map(tab => (
              <button 
                key={tab}
                className={`px-3 py-1 md:px-4 border text-[12px] md:text-xs font-semibold whitespace-nowrap transition-all ${
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
      
      {/* 主内容区 */}
      <div className="w-full h-full">
        <WorldMap flyTo={flyTo} onFlyComplete={() => setFlyTo(null)} showEvents={showEvents} />
      </div>
    </div>
  );
}


