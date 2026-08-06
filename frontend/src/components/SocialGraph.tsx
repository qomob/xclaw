import React, { useRef, useEffect, useState, useCallback } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';
import { fetchSocialGraph, fetchRelationshipStats, decaySocialGraph } from '../utils/api';

interface GraphNode {
  id: string;
  agent_name: string;
  trust_score: number;
  status: string;
  relationship_count: string;
}

interface GraphEdge {
  agent_id: string;
  related_agent_id: string;
  type: string;
  interaction_count: string;
  avg_rating: string;
  last_interaction_at: string | null;
  agent_name: string;
  related_name: string;
}

type SimNode = GraphNode & { x: number; y: number; fx?: number | null; fy?: number | null };

const TYPE_COLORS: Record<string, string> = {
  trusted: '#22d3ee',
  blocked: '#ef4444',
  neutral: '#64748b',
};

const STATUS_COLORS: Record<string, string> = {
  online: '#22c55e',
  busy: '#f59e0b',
  offline: '#64748b',
};

export default function SocialGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decaying, setDecaying] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<SimNode | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<(GraphEdge & { source: SimNode | string; target: SimNode | string })[]>([]);
  const [zoomLevel, setZoomLevel] = useState(1);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ node: SimNode | null; panning: boolean; startX: number; startY: number; startTx: number; startTy: number }>({ node: null, panning: false, startX: 0, startY: 0, startTx: 0, startTy: 0 });
  const hoveredNodeRef = useRef<SimNode | null>(null);

  const getNodeRadius = useCallback((node: SimNode) => {
    const count = parseInt(node.relationship_count) || 0;
    return Math.max(8, Math.min(24, 8 + count * 3));
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = dimensions;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const { x: tx, y: ty, k } = transformRef.current;
    const hovered = hoveredNodeRef.current;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(k, k);

    for (const link of edgesRef.current) {
      const src = typeof link.source === 'object' ? link.source : null;
      const tgt = typeof link.target === 'object' ? link.target : null;
      if (!src || !tgt) continue;

      const rating = parseFloat(link.avg_rating) || 0.5;
      const lastDate = link.last_interaction_at ? new Date(link.last_interaction_at) : null;
      const daysSince = lastDate ? (Date.now() - lastDate.getTime()) / 86400000 : 999;
      const decayAlpha = Math.max(0.1, Math.min(0.8, rating * Math.pow(0.95, Math.min(daysSince, 60))));

      const isEdgeHovered = hovered && (hovered.id === link.agent_id || hovered.id === link.related_agent_id);

      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.strokeStyle = TYPE_COLORS[link.type] || '#334155';
      ctx.globalAlpha = isEdgeHovered ? 0.9 : decayAlpha;
      ctx.lineWidth = Math.max(0.5, Math.min(4, (parseInt(link.interaction_count) || 1) * 0.6));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const node of nodesRef.current) {
      const r = getNodeRadius(node);
      const isHovered = hovered?.id === node.id;
      const trust = node.trust_score ?? 0;

      if (trust > 0) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 6, 0, 2 * Math.PI);
        const trustHue = trust * 120;
        ctx.fillStyle = `hsla(${trustHue}, 70%, 50%, ${isHovered ? 0.35 : 0.15})`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, r + (isHovered ? 4 : 0), 0, 2 * Math.PI);
      const statusColor = STATUS_COLORS[node.status] || '#64748b';
      ctx.fillStyle = isHovered ? '#38bdf8' : statusColor;
      ctx.globalAlpha = isHovered ? 0.3 : 0.15;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = isHovered ? '#38bdf8' : statusColor;
      ctx.fill();

      ctx.strokeStyle = isHovered ? '#7dd3fc' : '#1e293b';
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.stroke();

      ctx.fillStyle = isHovered ? '#e0f2fe' : '#94a3b8';
      ctx.font = `${isHovered ? 11 : 9}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(node.agent_name, node.x, node.y + r + 14);
    }

    ctx.restore();

    const legendX = 12;
    let legendY = height - 60;
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#475569';
    ctx.fillText('Relation Type:', legendX, legendY);
    legendY += 14;
    for (const [t, c] of Object.entries(TYPE_COLORS)) {
      ctx.fillStyle = c;
      ctx.fillRect(legendX, legendY - 6, 8, 8);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(t, legendX + 12, legendY);
      legendY += 13;
    }
    legendY += 2;
    ctx.fillStyle = '#475569';
    ctx.fillText('Halo=Trust  Green->Red=High->Low', legendX, legendY);

    if (hovered) {
      const sx = hovered.x * k + tx;
      const sy = hovered.y * k + ty;
      const tooltipX = sx + 16;
      const tooltipY = sy - 10;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;

      const trustStr = Number(hovered.trust_score ?? 0).toFixed(2);
      const relStr = hovered.relationship_count || '0';
      const trustLevel = hovered.trust_score >= 0.7 ? 'High' : hovered.trust_score >= 0.4 ? 'Med' : 'Low';
      const nodeEdges = edgesRef.current.filter(
        e => (typeof e.source === 'object' && e.source.id === hovered.id) ||
             (typeof e.target === 'object' && e.target.id === hovered.id)
      );
      const trustedCount = nodeEdges.filter(e => e.type === 'trusted').length;
      const lastInteraction = nodeEdges.length > 0
        ? nodeEdges.reduce((latest, e) => {
            if (!e.last_interaction_at) return latest;
            const d = new Date(e.last_interaction_at);
            return d > latest ? d : latest;
          }, new Date(0))
        : null;
      const daysAgo = lastInteraction && lastInteraction.getTime() > 0
        ? Math.floor((Date.now() - lastInteraction.getTime()) / 86400000)
        : null;

      const lines = [
        hovered.agent_name,
        `Trust: ${trustStr} (${trustLevel})`,
        `Relations: ${relStr} | Trusted: ${trustedCount}`,
        `Status: ${hovered.status}`,
        daysAgo !== null ? `Last Interaction: ${daysAgo}d ago` : 'No Interactions',
      ];
      const lineHeight = 16;
      const padding = 8;
      ctx.font = '10px monospace';
      const maxW = Math.max(...lines.map(l => ctx.measureText(l).width)) + padding * 2;
      const boxH = lines.length * lineHeight + padding * 2;

      ctx.beginPath();
      ctx.roundRect(tooltipX, tooltipY, maxW, boxH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'left';
      lines.forEach((line, i) => {
        ctx.fillText(line, tooltipX + padding, tooltipY + padding + 10 + i * lineHeight);
      });
    }
  }, [dimensions, getNodeRadius]);

  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  });
  useEffect(() => {
    draw();
  }, [draw, hoveredNode]);

  const [stats, setStats] = useState<{ total_nodes: number; total_edges: number; avg_trust_score: number } | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetchRelationshipStats();
      if (res.success && res.data) {
        setStats({
          total_nodes: res.data.total_nodes ?? 0,
          total_edges: res.data.total_edges ?? 0,
          avg_trust_score: res.data.avg_trust_score ?? 0,
        });
      }
    } catch {
      // stats fetch is non-critical, silently ignore
    }
  }, []);

  useEffect(() => {
    if (dimensions.width === 0 || dimensions.height === 0) return;
    let cancelled = false;
    const init = async () => {
      try {
        const res = await fetchSocialGraph();
        if (cancelled) return;
        if (!res.success) { setError(res.error || 'Load Failed'); setLoading(false); return; }
        const rawNodes: GraphNode[] = res.data.nodes || [];
        const rawEdges: GraphEdge[] = res.data.edges || [];
        if (rawNodes.length === 0) { setError('No Relationship Data'); setLoading(false); return; }

        const simNodes: SimNode[] = rawNodes.map((n, i) => ({
          ...n,
          x: dimensions.width / 2 + Math.cos((2 * Math.PI * i) / rawNodes.length) * 200,
          y: dimensions.height / 2 + Math.sin((2 * Math.PI * i) / rawNodes.length) * 200,
        }));

        const simLinks = rawEdges.map(e => ({
          ...e,
          source: e.agent_id,
          target: e.related_agent_id,
        }));

        if (cancelled) return;
        nodesRef.current = simNodes;
        edgesRef.current = simLinks;
        setNodes(simNodes);
        setEdges(rawEdges);

        const simulation = forceSimulation<SimNode>(simNodes)
          .force('link', forceLink<SimNode, (GraphEdge & { source: SimNode | string; target: SimNode | string })>(simLinks)
            .id(d => d.id)
            .distance(100)
          )
          .force('charge', forceManyBody().strength(-300))
          .force('center', forceCenter(dimensions.width / 2, dimensions.height / 2))
          .force('collide', forceCollide<SimNode>().radius(30))
          .on('tick', () => { nodesRef.current = simNodes; drawRef.current(); });

        if (cancelled) { simRef.current?.stop(); return; }
        simRef.current = simulation;
        setLoading(false);
        loadStats();
      } catch { if (!cancelled) { setError('Network Error'); setLoading(false); } }
    };
    init();
    return () => { cancelled = true; simRef.current?.stop(); };
  }, [dimensions.width, dimensions.height, loadStats]);

  const handleDecay = useCallback(async () => {
    setDecaying(true);
    try {
      await decaySocialGraph();
      // Reload graph after decay
      const res = await fetchSocialGraph();
      if (res.success) {
        const rawNodes: GraphNode[] = res.data.nodes || [];
        const rawEdges: GraphEdge[] = res.data.edges || [];
        if (rawNodes.length > 0) {
          const simNodes: SimNode[] = rawNodes.map((n, i) => ({
            ...n,
            x: dimensions.width / 2 + Math.cos((2 * Math.PI * i) / rawNodes.length) * 200,
            y: dimensions.height / 2 + Math.sin((2 * Math.PI * i) / rawNodes.length) * 200,
          }));
          const simLinks = rawEdges.map(e => ({
            ...e,
            source: e.agent_id,
            target: e.related_agent_id,
          }));
          nodesRef.current = simNodes;
          edgesRef.current = simLinks;
          setNodes(simNodes);
          setEdges(rawEdges);
          simRef.current?.restart();
        }
      }
    } catch (err) {
      console.error('Decay failed:', err);
    } finally {
      setDecaying(false);
      loadStats();
    }
  }, [dimensions.width, dimensions.height, loadStats]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const screenToGraph = useCallback((sx: number, sy: number) => {
    const { x: tx, y: ty, k } = transformRef.current;
    return { x: (sx - tx) / k, y: (sy - ty) / k };
  }, []);

  const findNodeAt = useCallback((gx: number, gy: number) => {
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n = nodesRef.current[i];
      const r = getNodeRadius(n);
      const dx = n.x - gx;
      const dy = n.y - gy;
      if (dx * dx + dy * dy <= (r + 4) * (r + 4)) return n;
    }
    return null;
  }, [getNodeRadius]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x: gx, y: gy } = screenToGraph(sx, sy);
    const node = findNodeAt(gx, gy);
    if (node) {
      simRef.current?.alphaTarget(0.3).restart();
      dragRef.current = { node, panning: false, startX: 0, startY: 0, startTx: 0, startTy: 0 };
    } else {
      const { x: tx, y: ty } = transformRef.current;
      dragRef.current = { node: null, panning: true, startX: sx, startY: sy, startTx: tx, startTy: ty };
    }
  }, [screenToGraph, findNodeAt]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (dragRef.current.node) {
      const { x: gx, y: gy } = screenToGraph(sx, sy);
      dragRef.current.node.fx = gx;
      dragRef.current.node.fy = gy;
      return;
    }

    if (dragRef.current.panning) {
      const dx = sx - dragRef.current.startX;
      const dy = sy - dragRef.current.startY;
      transformRef.current = {
        x: dragRef.current.startTx + dx,
        y: dragRef.current.startTy + dy,
        k: transformRef.current.k,
      };
      draw();
      return;
    }

    const { x: gx, y: gy } = screenToGraph(sx, sy);
    const node = findNodeAt(gx, gy);
    hoveredNodeRef.current = node;
    setHoveredNode(node);
    canvasRef.current!.style.cursor = node ? 'pointer' : 'grab';
  }, [screenToGraph, findNodeAt, draw]);

  const handleMouseUp = useCallback(() => {
    if (dragRef.current.node) {
      dragRef.current.node.fx = null;
      dragRef.current.node.fy = null;
      simRef.current?.alphaTarget(0);
    }
    dragRef.current = { node: null, panning: false, startX: 0, startY: 0, startTx: 0, startTy: 0 };
  }, []);

  const getTouchPos = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !e.touches[0]) return null;
    return { sx: e.touches[0].clientX - rect.left, sy: e.touches[0].clientY - rect.top };
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const pos = getTouchPos(e);
    if (!pos) return;
    const { sx, sy } = pos;
    const { x: gx, y: gy } = screenToGraph(sx, sy);
    const node = findNodeAt(gx, gy);
    if (node) {
      simRef.current?.alphaTarget(0.3).restart();
      dragRef.current = { node, panning: false, startX: 0, startY: 0, startTx: 0, startTy: 0 };
    } else {
      const { x: tx, y: ty } = transformRef.current;
      dragRef.current = { node: null, panning: true, startX: sx, startY: sy, startTx: tx, startTy: ty };
    }
  }, [getTouchPos, screenToGraph, findNodeAt]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const pos = getTouchPos(e);
    if (!pos) return;
    const { sx, sy } = pos;
    if (dragRef.current.node) {
      const { x: gx, y: gy } = screenToGraph(sx, sy);
      dragRef.current.node.fx = gx;
      dragRef.current.node.fy = gy;
      return;
    }
    if (dragRef.current.panning) {
      const dx = sx - dragRef.current.startX;
      const dy = sy - dragRef.current.startY;
      transformRef.current = {
        x: dragRef.current.startTx + dx,
        y: dragRef.current.startTy + dy,
        k: transformRef.current.k,
      };
      draw();
    }
  }, [getTouchPos, screenToGraph, draw]);

  const handleTouchEnd = useCallback(() => {
    handleMouseUp();
  }, [handleMouseUp]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { k } = transformRef.current;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newK = Math.max(0.2, Math.min(5, k * delta));
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    transformRef.current = {
      x: sx - (sx - transformRef.current.x) * (newK / k),
      y: sy - (sy - transformRef.current.y) * (newK / k),
      k: newK,
    };
    setZoomLevel(newK);
    draw();
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleZoomIn = useCallback(() => {
    const { k, x, y } = transformRef.current;
    const newK = Math.min(5, k * 1.2);
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    transformRef.current = {
      x: centerX - (centerX - x) * (newK / k),
      y: centerY - (centerY - y) * (newK / k),
      k: newK,
    };
    setZoomLevel(newK);
    draw();
  }, [draw, dimensions]);

  const handleZoomOut = useCallback(() => {
    const { k, x, y } = transformRef.current;
    const newK = Math.max(0.2, k * 0.8);
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    transformRef.current = {
      x: centerX - (centerX - x) * (newK / k),
      y: centerY - (centerY - y) * (newK / k),
      k: newK,
    };
    setZoomLevel(newK);
    draw();
  }, [draw, dimensions]);

  const handleResetView = useCallback(() => {
    transformRef.current = { x: 0, y: 0, k: 1 };
    setZoomLevel(1);
    draw();
  }, [draw]);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#0f172a] text-cyan-400 text-xs font-mono">
        LOADING SOCIAL GRAPH...
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#0f172a] gap-3">
        <span className="text-gray-400 text-xs font-mono">{error}</span>
        <button onClick={() => window.location.reload()} className="px-3 py-1 text-[12px] bg-cyan-600 hover:bg-cyan-700 text-white rounded font-bold">
          RETRY
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative" style={{ touchAction: 'none', overflow: 'hidden' }}>
      <div className="absolute top-2 left-2 z-10 flex gap-2 items-center">
        <span className="text-[12px] text-gray-400 font-mono">
          {nodes.length} AGENTS · {edges.length} CONNECTIONS
        </span>
        <button onClick={() => window.location.reload()} className="text-[12px] text-gray-400 hover:text-cyan-400 font-mono" title="Refresh">↻</button>
        <button 
          onClick={handleDecay} 
          disabled={decaying}
          className="text-[12px] text-amber-500 hover:text-amber-400 font-mono disabled:opacity-30" 
          title="Decay stale relationships"
        >
          {decaying ? '⏳' : '⟳'}
        </button>
      </div>
      <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
        <div className="flex gap-3 text-[11px] text-gray-400 font-mono">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-cyan-400 inline-block" /> TRUSTED
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> BLOCKED
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-gray-500 inline-block" /> NEUTRAL
          </span>
        </div>
        {stats && (
          <div className="flex gap-3 text-[11px] text-gray-400 font-mono bg-slate-800/80 px-2 py-1 rounded border border-slate-700">
            <span title="Total Nodes">◉ {stats.total_nodes}</span>
            <span title="Total Edges">⟷ {stats.total_edges}</span>
            <span title="Avg Trust Score">⌀ {(stats.avg_trust_score ?? 0).toFixed(2)}</span>
          </div>
        )}
      </div>
      <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-2">
        <button
          onClick={handleZoomIn}
          disabled={zoomLevel >= 5}
          className="w-8 h-8 bg-slate-800/90 hover:bg-slate-700 border border-slate-600 rounded text-white text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Zoom In (+)"
        >
          +
        </button>
        <div className="text-center text-[11px] text-gray-400 font-mono bg-slate-800/90 px-2 py-0.5 rounded border border-slate-600">
          {(zoomLevel * 100).toFixed(0)}%
        </div>
        <button
          onClick={handleZoomOut}
          disabled={zoomLevel <= 0.2}
          className="w-8 h-8 bg-slate-800/90 hover:bg-slate-700 border border-slate-600 rounded text-white text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Zoom Out (-)"
        >
          −
        </button>
        <button
          onClick={handleResetView}
          className="w-8 h-8 bg-slate-800/90 hover:bg-slate-700 border border-slate-600 rounded text-white text-[12px] font-bold transition-colors"
          title="Reset View"
        >
          ⟲
        </button>
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
    </div>
  );
}
