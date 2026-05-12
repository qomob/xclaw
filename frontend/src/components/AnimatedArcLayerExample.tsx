import React, { useState, useEffect, useRef, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import AnimatedArcLayer from './AnimatedArcLayer';

// 初始视图状态
const INITIAL_VIEW_STATE = {
  longitude: 0,
  latitude: 20,
  zoom: 1.5,
  pitch: 45,
  bearing: 0
};

interface Agent {
  id: string;
  name: string;
  group: number;
  lat: number;
  lng: number;
  online: boolean;
}

interface Task {
  id: string;
  from: string;
  to: string;
  from_lat: number;
  from_lng: number;
  to_lat: number;
  to_lng: number;
}

// 模拟数据
const mockAgents: Agent[] = [
  { id: '1', name: 'LLM Agent 1', group: 1, lat: 37.7749, lng: -122.4194, online: true },
  { id: '2', name: 'Vision Agent 1', group: 2, lat: 40.7128, lng: -74.0060, online: true },
  { id: '3', name: 'Data Agent 1', group: 3, lat: 51.5074, lng: -0.1278, online: true },
  { id: '4', name: 'LLM Agent 2', group: 1, lat: 35.6762, lng: 139.6503, online: true },
  { id: '5', name: 'Vision Agent 2', group: 2, lat: -33.8688, lng: 151.2093, online: true },
  { id: '6', name: 'Data Agent 2', group: 3, lat: 28.6139, lng: 77.2090, online: true },
  { id: '7', name: 'LLM Agent 3', group: 1, lat: 55.7558, lng: 37.6173, online: true },
  { id: '8', name: 'Vision Agent 3', group: 2, lat: 39.9042, lng: 116.4074, online: true },
  { id: '9', name: 'Data Agent 3', group: 3, lat: -23.5505, lng: -46.6333, online: true },
  { id: '10', name: 'LLM Agent 4', group: 1, lat: 30.0444, lng: 31.2357, online: true },
];

const mockTasks: Task[] = [
  { id: '1', from: '1', to: '2', from_lat: 37.7749, from_lng: -122.4194, to_lat: 40.7128, to_lng: -74.0060 },
  { id: '2', from: '2', to: '3', from_lat: 40.7128, from_lng: -74.0060, to_lat: 51.5074, to_lng: -0.1278 },
  { id: '3', from: '3', to: '4', from_lat: 51.5074, from_lng: -0.1278, to_lat: 35.6762, to_lng: 139.6503 },
  { id: '4', from: '4', to: '5', from_lat: 35.6762, from_lng: 139.6503, to_lat: -33.8688, to_lng: 151.2093 },
  { id: '5', from: '5', to: '6', from_lat: -33.8688, from_lng: 151.2093, to_lat: 28.6139, to_lng: 77.2090 },
  { id: '6', from: '6', to: '7', from_lat: 28.6139, from_lng: 77.2090, to_lat: 55.7558, to_lng: 37.6173 },
  { id: '7', from: '7', to: '8', from_lat: 55.7558, from_lng: 37.6173, to_lat: 39.9042, to_lng: 116.4074 },
  { id: '8', from: '8', to: '9', from_lat: 39.9042, from_lng: 116.4074, to_lat: -23.5505, to_lng: -46.6333 },
  { id: '9', from: '9', to: '10', from_lat: -23.5505, from_lng: -46.6333, to_lat: 30.0444, to_lng: 31.2357 },
  { id: '10', from: '10', to: '1', from_lat: 30.0444, from_lng: 31.2357, to_lat: 37.7749, to_lng: -122.4194 },
];

// 根据分组获取颜色
const getAgentColor = (group: number): [number, number, number] => {
  const colors: [number, number, number][] = [
    [239, 68, 68], // 红色 - LLM Reasoning
    [16, 185, 129], // 绿色 - Vision Engine
    [14, 165, 233], // 蓝色 - Data Processing
    [245, 158, 11], // 黄色 - Translation
    [139, 92, 246], // 紫色 - Crawler
    [236, 72, 153], // 粉色 - Weather
    [20, 184, 166], // 青色 - Finance
    [249, 115, 22], // 橙色 - Health
    [59, 130, 246], // 蓝色 - Security
    [99, 102, 241], // 靛蓝 - Gaming
    [132, 204, 22], // 绿色 - Education
    [236, 72, 153], // 粉色 - Entertainment
  ];
  return colors[(group - 1) % colors.length] || [128, 128, 128];
};

export default function AnimatedArcLayerExample() {
  // 时间状态
  const [time, setTime] = useState(0);
  // 动画帧请求 ID
  const animationRef = useRef<number>(undefined);

  // 启动动画
  useEffect(() => {
    const animate = (timestamp: number) => {
      // 更新时间
      setTime(timestamp / 1000); // 转换为秒
      // 请求下一帧
      animationRef.current = requestAnimationFrame(animate);
    };

    // 启动动画
    animationRef.current = requestAnimationFrame(animate);

    // 清理函数
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  // 最终图层数组
  const layers = useMemo(() => {
    // Agent 节点层
    const agentLayer = new ScatterplotLayer({
      id: 'agent-layer',
      data: mockAgents,
      pickable: true,
      opacity: 0.8,
      stroked: true,
      filled: true,
      radiusScale: 10,
      radiusMinPixels: 3,
      radiusMaxPixels: 15,
      getPosition: (d: Agent) => [d.lng, d.lat],
      getFillColor: (d: Agent) => getAgentColor(d.group),
      getLineColor: () => [0, 0, 0],
      getRadius: (d: Agent) => (d.online ? 5 : 3),
    });

    // 动画弧线层
    const animatedArcLayerInstance = new AnimatedArcLayer({
      id: 'animated-arc-layer',
      data: mockTasks,
      pickable: true,
      getWidth: 2,
      getSourcePosition: (d: Task) => [d.from_lng, d.from_lat],
      getTargetPosition: (d: Task) => [d.to_lng, d.to_lat],
      getSourceColor: () => [0, 255, 255, 200], // 青色出发
      getTargetColor: () => [255, 0, 255, 200], // 紫色到达
      getHeight: 100000, // 光束高度
      getTilt: 45, // 光束倾斜度
      time: time, // 传递时间参数
    });

    return [agentLayer, animatedArcLayerInstance];
  }, [time]);

  return (
    <div className="w-full h-full relative bg-slate-900">
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
        getTooltip={(info: { object?: Agent }) => info.object ? `${info.object.name}` : null}
        style={{ width: '100%', height: '100%' }}
        useDevicePixels={false}
      />
      <div className="absolute top-4 left-4 z-10 bg-black/60 backdrop-blur-md p-4 rounded-lg border border-cyan-500/30 text-white font-mono pointer-events-none">
        <h2 className="text-cyan-400 font-bold mb-2">AnimatedArcLayer Example</h2>
        <div className="text-xs space-y-1 opacity-80">
          <p>TIME: {time.toFixed(2)}s</p>
          <p>NODES: {mockAgents.length}</p>
          <p>LINKS: {mockTasks.length}</p>
        </div>
      </div>
    </div>
  );
}
