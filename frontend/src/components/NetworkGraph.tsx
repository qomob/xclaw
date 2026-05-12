import React, { useRef, useState, useEffect, useCallback } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import { getClustersByZoomLevel, clustersToNodes } from '../utils/clustering';

// 严格定义数据接口
interface Node {
  id: string;
  name: string;
  group: number; // 用于决定颜色（基于能力聚类）
  val: number;   // 节点大小（如：活跃度权重）
  tags: string[];
  x?: number;
  y?: number;
  z?: number;
}

interface Link {
  source: string;
  target: string;
  weight: number;
}

interface GraphData {
  nodes: Node[];
  links: Link[];
}

interface NetworkGraphProps {
  graphData: GraphData;
  highlightNodes: Set<string>;
  onNodeClick: (node: Node) => void;
}

export default function NetworkGraph({ graphData, highlightNodes, onNodeClick }: NetworkGraphProps) {
  const fgRef = useRef<any>(null);
  const [physicsWorker, setPhysicsWorker] = useState<Worker | null>(null);
  const [nodesWithPosition, setNodesWithPosition] = useState<Node[]>(graphData.nodes);
  const [animationFrameId, setAnimationFrameId] = useState<number | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(0);
  const [displayNodes, setDisplayNodes] = useState<Node[]>(graphData.nodes);

  // 初始化 Web Worker
  useEffect(() => {
    // 创建 Web Worker
    const workerUrl = new URL('../workers/physics.worker.ts', import.meta.url);
    const worker = new Worker(workerUrl.href, { type: 'module' }) as Worker;
    
    // 处理 Worker 消息
    worker.onmessage = (event) => {
      const { type, data } = event.data;
      if (type === 'tick') {
        // 更新节点位置
        const updatedNodes = nodesWithPosition.map(node => {
          const updatedNode = data.nodes.find((n: any) => n.id === node.id);
          return updatedNode ? { ...node, ...updatedNode } : node;
        });
        setNodesWithPosition(updatedNodes);
      }
    };
    
    setPhysicsWorker(worker);
    
    // 清理
    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      worker.terminate();
    };
  }, []);

  // 初始化节点数据
  useEffect(() => {
    if (physicsWorker) {
      // 向 Worker 发送初始化数据
      physicsWorker.postMessage({
        type: 'init',
        data: {
          nodes: graphData.nodes,
          links: graphData.links,
          config: {
            linkDistance: 15,
            charge: -400,
            centerStrength: 0.15
          }
        }
      });
    }
  }, [graphData, physicsWorker]);

  // 动画循环
  useEffect(() => {
    if (!physicsWorker) return;
    
    const animate = () => {
      physicsWorker.postMessage({ type: 'tick' });
      const id = requestAnimationFrame(animate);
      setAnimationFrameId(id);
    };
    
    const id = requestAnimationFrame(animate);
    setAnimationFrameId(id);
    
    return () => {
      if (id) {
        cancelAnimationFrame(id);
      }
    };
  }, [physicsWorker]);

  // 监听节点位置变化和缩放级别，更新聚类
  useEffect(() => {
    // 只有当节点数量超过 50 时才启用聚类
    if (nodesWithPosition.length > 50) {
      const clusters = getClustersByZoomLevel(nodesWithPosition, zoomLevel);
      const clusterNodes = clustersToNodes(clusters);
      setDisplayNodes(clusterNodes);
    } else {
      // 节点数量较少时，直接显示所有节点
      setDisplayNodes(nodesWithPosition);
    }
  }, [nodesWithPosition, zoomLevel]);



  // 节点点击事件：镜头拉近并聚焦
  const handleNodeClick = useCallback((node: Node) => {
    if (!fgRef.current) return;
    
    // 计算摄像机的新位置（与节点保持一定距离）
    const distance = 40;
    const distRatio = 1 + distance / Math.hypot(node.x || 0, node.y || 0, node.z || 0);
    
    fgRef.current.cameraPosition(
      { x: (node.x || 0) * distRatio, y: (node.y || 0) * distRatio, z: (node.z || 0) * distRatio }, // 新坐标
      node, // 视角注视点
      3000  // 动画时长 (ms)
    );
    
    // 触发外部点击事件
    onNodeClick(node);
  }, [onNodeClick]);

  // 自定义节点渲染
  const nodeThreeObject = useCallback((node: Node) => {
    const geometry = new THREE.SphereGeometry(Math.cbrt(node.val) * 2, 16, 16);
    
    // 根据是否高亮决定材质
    const isHighlighted = highlightNodes.has(node.id);
    const material = new THREE.MeshLambertMaterial({ 
      color: isHighlighted ? 0x06b6d4 : getGroupColor(node.group),
      transparent: true,
      opacity: isHighlighted ? 1 : 0.8,
      emissive: isHighlighted ? 0x06b6d4 : 0x000000,
      emissiveIntensity: isHighlighted ? 0.5 : 0
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    // 高亮节点放大1.5倍
    if (isHighlighted) {
      mesh.scale.set(1.5, 1.5, 1.5);
    }
    return mesh;
  }, [highlightNodes]);

  // 根据分组获取颜色
  const getGroupColor = (group: number): number => {
    const colors = [0x3b82f6, 0xef4444, 0x10b981, 0xf59e0b]; // 蓝、红、绿、黄
    return colors[(group - 1) % colors.length];
  };

  // 自定义连线样式
  const linkColor = useCallback(() => {
    return 'rgba(255,255,255,0.2)';
  }, []);

  // 组合图形数据，过滤掉无效的连线
  const combinedGraphData = {
    nodes: displayNodes,
    links: graphData.links.filter(link => {
      // 确保源节点和目标节点都存在
      const sourceNode = displayNodes.find(node => node.id === link.source);
      const targetNode = displayNodes.find(node => node.id === link.target);
      return sourceNode && targetNode;
    })
  };

  // 处理缩放事件
  const handleZoom = useCallback((zoom: number) => {
    // 缩放级别范围：0-10
    const normalizedZoom = Math.max(0, Math.min(10, zoom));
    setZoomLevel(normalizedZoom);
  }, []);

  return (
    <div className="w-full h-screen bg-black overflow-hidden relative">
      {/* 核心 3D 渲染组件 */}
      <ForceGraph3D
        ref={fgRef}
        graphData={combinedGraphData}
        nodeLabel="name"
        nodeAutoColorBy="group"
        nodeThreeObject={nodeThreeObject}
        onNodeClick={handleNodeClick}
        onZoom={handleZoom}
        linkWidth={(link) => link.weight * 2}
        linkColor={linkColor}
        linkDirectionalParticles={2} // 光子流动效果，表示 A2A 数据流向
        linkDirectionalParticleWidth={2}
        backgroundColor="#000000"
        forceEngine="none" // 禁用默认力导向布局，使用 Web Worker
      />
    </div>
  );
}
