import React from 'react';
import type { GalaxyNode, GalaxyEdge } from './GalaxyView';

export interface NodeDetailProps {
  node: GalaxyNode;
  edges: GalaxyEdge[];
  onClose: () => void;
  onSendMessage?: (agentId: string) => void;
  onDelegateTask?: (agentId: string) => void;
  onViewSocialGraph?: (agentId: string) => void;
}

function getNodeColor(capabilities: string[]): string {
  const map: Record<string, string> = {
    search: '#4dabf7',
    discovery: '#4dabf7',
    creative: '#ff6b9d',
    content: '#ff6b9d',
    analysis: '#00ff88',
    data: '#00ff88',
    communication: '#ffd43b',
    collaboration: '#ffd43b',
    infrastructure: '#845ef7',
    system: '#845ef7',
  };
  for (const cap of capabilities) {
    const lower = cap.toLowerCase();
    for (const [key, color] of Object.entries(map)) {
      if (lower.includes(key)) return color;
    }
  }
  return '#20c997';
}

function StarRating({ score, max = 5 }: { score: number; max?: number }) {
  const stars = Math.round((score / 100) * max);
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < stars ? 'text-yellow-400' : 'text-gray-400'}>
          ★
        </span>
      ))}
    </span>
  );
}

const NodeDetail: React.FC<NodeDetailProps> = ({
  node,
  edges,
  onClose,
  onSendMessage,
  onDelegateTask,
  onViewSocialGraph,
}) => {
  const color = getNodeColor(node.capabilities);
  const connectionCount = edges.filter(
    (e) => e.source === node.id || e.target === node.id
  ).length;

  return (
    <div
      className="absolute right-3 top-3 z-30 w-72 rounded-xl border p-4 flex flex-col gap-3 select-none overflow-y-auto"
      style={{
        background: 'rgba(0,0,17,0.92)',
        borderColor: color,
        maxHeight: '80vh',
        backdropFilter: 'blur(8px)',
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          {/* Avatar placeholder */}
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm"
            style={{ background: color }}
          >
            {node.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="text-white font-semibold text-sm">{node.name}</div>
            <div className="flex items-center gap-1 text-xs">
              <span
                className="w-2 h-2 rounded-full inline-block"
                style={{
                  background: node.online ? '#00ff88' : '#666',
                }}
              />
              <span className={node.online ? 'text-green-400' : 'text-gray-400'}>
                {node.online ? 'Online' : 'Offline'}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white transition text-lg leading-none"
        >
          ✕
        </button>
      </div>

      {/* Capabilities */}
      <div>
        <div className="text-gray-400 text-xs mb-1">Capabilities</div>
        <div className="flex flex-wrap gap-1">
          {node.capabilities.map((cap) => (
            <span
              key={cap}
              className="px-1.5 py-0.5 rounded text-xs"
              style={{
                background: `${color}22`,
                color,
                border: `1px solid ${color}44`,
              }}
            >
              {cap}
            </span>
          ))}
        </div>
      </div>

      {/* Reputation */}
      <div>
        <div className="text-gray-400 text-xs mb-1">Reputation</div>
        <div className="flex items-center gap-2">
          <StarRating score={node.reputation} />
          <span className="text-white text-sm font-mono">
            {node.reputation.toFixed(1)}
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-gray-900/60 p-2 text-center">
          <div className="text-white font-bold text-lg">{connectionCount}</div>
          <div className="text-gray-400 text-xs">Connections</div>
        </div>
        <div className="rounded-lg bg-gray-900/60 p-2 text-center">
          <div className={`text-white font-bold text-lg ${node.online ? 'text-green-400' : 'text-red-400'}`}>
            {node.online ? 'ONLINE' : 'OFFLINE'}
          </div>
          <div className="text-gray-400 text-xs">Status</div>
        </div>
      </div>

      {/* Skills（能力标签来自节点注册数据） */}
      <div>
        <div className="text-gray-400 text-xs mb-1">Skills</div>
        <div className="flex flex-col gap-1">
          {node.capabilities.slice(0, 4).map((cap, i) => (
            <div
              key={cap}
              className="flex items-center justify-between text-xs px-2 py-1 rounded bg-gray-900/40"
            >
              <span className="text-gray-300">{cap}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-1.5 mt-1">
        <button
          onClick={() => onSendMessage?.(node.id)}
          className="w-full px-3 py-1.5 rounded text-xs font-medium transition text-white"
          style={{ background: `${color}cc` }}
        >
          💬 Send Message
        </button>
        <button
          onClick={() => onDelegateTask?.(node.id)}
          className="w-full px-3 py-1.5 rounded text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 transition"
        >
          📋 Assign Task
        </button>
        <button
          onClick={() => onViewSocialGraph?.(node.id)}
          className="w-full px-3 py-1.5 rounded text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 transition"
        >
          🕸 View Social Graph
        </button>
      </div>
    </div>
  );
};

export default NodeDetail;
