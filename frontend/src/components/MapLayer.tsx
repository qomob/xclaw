import React, { useState, useEffect } from 'react';
import { DeckGL } from '@deck.gl/react';
import { ArcLayer, ScatterplotLayer } from '@deck.gl/layers';
import { StaticMap } from 'react-map-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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

interface MapLayerProps {
  agents: Agent[];
  tasks: Task[];
}

export default function MapLayer({ agents, tasks }: MapLayerProps) {
  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 0,
    zoom: 1.5,
    pitch: 0,
    bearing: 0
  });

  // 根据分组获取颜色
  const getGroupColor = (group: number) => {
    const colors = [
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
    return colors[(group - 1) % colors.length];
  };

  // 准备 Agent 数据
  const agentData = agents.map(agent => ({
    position: [agent.lng, agent.lat],
    color: getGroupColor(agent.group),
    radius: agent.online ? 5 : 3,
    group: agent.group,
    name: agent.name
  }));

  // 准备 Task 数据
  const taskData = tasks.map(task => ({
    sourcePosition: [task.from_lng, task.from_lat],
    targetPosition: [task.to_lng, task.to_lat],
    color: [14, 165, 233, 128],
    width: 2
  }));

  // 图层配置
  const layers = [
    // 任务路由弧线图层
    new ArcLayer({
      id: 'task-arcs',
      data: taskData,
      getSourcePosition: d => d.sourcePosition,
      getTargetPosition: d => d.targetPosition,
      getSourceColor: d => d.color,
      getTargetColor: d => d.color,
      getWidth: d => d.width,
      strokeWidth: 2,
      lineWidthMinPixels: 1,
      lineWidthMaxPixels: 3,
      opacity: 0.8
    }),
    // Agent 点图层
    new ScatterplotLayer({
      id: 'agent-points',
      data: agentData,
      getPosition: d => d.position,
      getColor: d => d.color,
      getRadius: d => d.radius,
      radiusMinPixels: 2,
      radiusMaxPixels: 8,
      opacity: 0.9
    })
  ];

  return (
    <div className="w-full h-full">
      <DeckGL
        initialViewState={viewState}
        controller={true}
        layers={layers}
        style={{ width: '100%', height: '100%' }}
      >
        <StaticMap
          mapLib={window.maplibregl}
          mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
          preventStyleDiffing={true}
        />
      </DeckGL>
    </div>
  );
}
