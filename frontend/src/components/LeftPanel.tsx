import React from 'react';

interface AgentGroup {
  id: number;
  name: string;
  count: number;
  color: string;
}

interface LeftPanelProps {
  agentGroups: AgentGroup[];
}

export default function LeftPanel({ agentGroups }: LeftPanelProps) {
  return (
    <div className="col-span-2 border border-[#1E293B] bg-slate-900/50 backdrop-blur-sm rounded-sm p-4 flex flex-col gap-2">
      <h2 className="text-sm font-bold text-cyan-400 mb-2">SENSOR GRID</h2>
      <div className="space-y-2 flex-1 overflow-y-auto">
        {agentGroups.map(group => (
          <div key={group.id} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div 
                className="w-2 h-2 rounded-full" 
                style={{ backgroundColor: group.color }}
              ></div>
              <span className="text-xs">{group.name}</span>
            </div>
            <span className="text-xs font-semibold text-cyan-400">{group.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
