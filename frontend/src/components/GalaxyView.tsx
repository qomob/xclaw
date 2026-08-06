import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Stars } from '@react-three/drei';
import * as THREE from 'three';
import {
  fibonacciSphere,
  forceDirectedLayout,
  hierarchyLayout,
  type LayoutEdge,
} from '../utils/galaxyLayout';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GalaxyNode {
  id: string;
  name: string;
  capabilities: string[];
  reputation: number;
  online: boolean;
  position: [number, number, number];
  group?: number;
}

export interface GalaxyEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GalaxyViewProps {
  nodes: GalaxyNode[];
  edges: GalaxyEdge[];
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  selectedNode?: string | null;
  layout?: 'force' | 'sphere' | 'hierarchy';
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const CAPABILITY_COLORS: Record<string, string> = {
  search: '#4dabf7',
  discovery: '#4dabf7',
  creative: '#ff6b9d',
  content: '#ff6b9d',
  writing: '#ff6b9d',
  analysis: '#00ff88',
  data: '#00ff88',
  analytics: '#00ff88',
  communication: '#ffd43b',
  collaboration: '#ffd43b',
  messaging: '#ffd43b',
  infrastructure: '#845ef7',
  system: '#845ef7',
  monitoring: '#845ef7',
};

const DEFAULT_COLOR = '#20c997';

function getNodeColor(capabilities: string[]): string {
  for (const cap of capabilities) {
    const lower = cap.toLowerCase();
    for (const [key, color] of Object.entries(CAPABILITY_COLORS)) {
      if (lower.includes(key)) return color;
    }
  }
  return DEFAULT_COLOR;
}

// ---------------------------------------------------------------------------
// Layout helpers — compute positions when not provided
// ---------------------------------------------------------------------------

function computePositions(
  nodes: GalaxyNode[],
  edges: GalaxyEdge[],
  layout: 'force' | 'sphere' | 'hierarchy'
): Map<string, [number, number, number]> {
  if (nodes.length === 0) return new Map();

  // If every node already has a non-zero position, use them as-is.
  const allZero = nodes.every(
    (n) => (n.position?.[0] ?? 0) === 0 && (n.position?.[1] ?? 0) === 0 && (n.position?.[2] ?? 0) === 0
  );

  if (!allZero) {
    const m = new Map<string, [number, number, number]>();
    nodes.forEach((n) => m.set(n.id, (n.position ?? [0, 0, 0]) as [number, number, number]));
    return m;
  }

  const ids = nodes.map((n) => n.id);
  const layoutEdges: LayoutEdge[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
  }));

  let layoutNodes;
  switch (layout) {
    case 'force':
      layoutNodes = forceDirectedLayout(ids, layoutEdges, 100);
      break;
    case 'hierarchy': {
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      layoutNodes = hierarchyLayout(ids, (id) => {
        const node = nodeMap.get(id);
        return node ? node.group ?? 1 : 1;
      });
      break;
    }
    case 'sphere':
    default:
      layoutNodes = fibonacciSphere(ids);
      break;
  }

  const m = new Map<string, [number, number, number]>();
  layoutNodes.forEach((ln) => m.set(ln.id, [ln.x, ln.y, ln.z]));
  return m;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Glowing agent sphere */
function AgentSphere({
  node,
  position,
  isSelected,
  isHovered,
  onSelect,
  onHover,
}: {
  node: GalaxyNode;
  position: [number, number, number];
  isSelected: boolean;
  isHovered: boolean;
  onSelect: () => void;
  onHover: (hovered: boolean) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const color = useMemo(() => getNodeColor(node.capabilities), [node.capabilities]);
  const baseScale = useMemo(() => {
    const r = Math.max(0.3, Math.min(1.5, (node.reputation || 1) * 0.3));
    return r;
  }, [node.reputation]);

  const scale = isSelected || isHovered ? baseScale * 1.4 : baseScale;
  const threeColor = useMemo(() => new THREE.Color(color), [color]);

  useFrame((_state, delta) => {
    if (!meshRef.current) return;
    // Gentle pulse
    const pulse = 1 + Math.sin(_state.clock.elapsedTime * 2 + position[0]) * 0.05;
    const s = scale * pulse;
    meshRef.current.scale.setScalar(s);
  });

  return (
    <group position={position}>
      {/* Main sphere */}
      <mesh
        ref={meshRef}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(true);
        }}
        onPointerOut={() => onHover(false)}
      >
        <sphereGeometry args={[1, 16, 16]} />
        <meshStandardMaterial
          color={threeColor}
          emissive={threeColor}
          emissiveIntensity={isSelected ? 1.2 : isHovered ? 0.9 : 0.5}
          transparent
          opacity={node.online ? 1 : 0.45}
          roughness={0.3}
        />
      </mesh>

      {/* Glow ring (simple outer sphere) */}
      <mesh scale={[1.35, 1.35, 1.35]}>
        <sphereGeometry args={[1, 12, 12]} />
        <meshBasicMaterial
          color={threeColor}
          transparent
          opacity={isSelected ? 0.18 : isHovered ? 0.12 : 0.06}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Name label */}
      {(isHovered || isSelected) && (
        <Html
          position={[0, 1.6, 0]}
          center
          style={{
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          <div
            className="px-2 py-1 rounded text-xs whitespace-nowrap"
            style={{
              background: 'rgba(0,0,17,0.85)',
              color: '#fff',
              border: `1px solid ${color}`,
              fontFamily: 'monospace',
            }}
          >
            {node.name}
            {!node.online && (
              <span className="ml-1 text-gray-400">(offline)</span>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

/** Instanced agent spheres for large node counts (performance path) */
function AgentInstances({
  nodes,
  positions,
}: {
  nodes: GalaxyNode[];
  positions: Map<string, [number, number, number]>;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    if (!meshRef.current) return;
    nodes.forEach((node, i) => {
      const pos = positions.get(node.id) || [0, 0, 0];
      dummy.position.set(pos[0], pos[1], pos[2]);
      const s = Math.max(0.3, Math.min(1.2, (node.reputation || 1) * 0.25));
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
      const c = getNodeColor(node.capabilities);
      meshRef.current!.setColorAt(i, new THREE.Color(c));
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  }, [nodes, positions, dummy]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, nodes.length]}>
      <sphereGeometry args={[1, 10, 10]} />
      <meshStandardMaterial
        emissive={new THREE.Color('#ffffff')}
        emissiveIntensity={0.3}
        roughness={0.4}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

/** Connection lines between agents */
function GalaxyEdges({
  edges,
  positions,
  hoveredNode,
}: {
  edges: GalaxyEdge[];
  positions: Map<string, [number, number, number]>;
  hoveredNode: string | null;
}) {
  const linesRef = useRef<THREE.Group>(null);

  const visibleEdges = useMemo(() => {
    return edges.filter((e) => positions.has(e.source) && positions.has(e.target));
  }, [edges, positions]);

  // Flowing particles along edges
  const FlowParticles = ({ edge }: { edge: GalaxyEdge }) => {
    const ref = useRef<THREE.Mesh>(null);
    const sp = positions.get(edge.source)!;
    const tp = positions.get(edge.target)!;
    const src = new THREE.Vector3(sp[0], sp[1], sp[2]);
    const tgt = new THREE.Vector3(tp[0], tp[1], tp[2]);

    useFrame((state) => {
      if (!ref.current) return;
      const t = ((state.clock.elapsedTime * 0.3 + edge.weight * 0.1) % 1);
      ref.current.position.lerpVectors(src, tgt, t);
    });

    return (
      <mesh ref={ref}>
        <sphereGeometry args={[0.08, 4, 4]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.7} />
      </mesh>
    );
  };

  return (
    <group ref={linesRef}>
      {visibleEdges.map((edge, i) => {
        const sp = positions.get(edge.source)!;
        const tp = positions.get(edge.target)!;
        const isHighlighted =
          hoveredNode === edge.source || hoveredNode === edge.target;
        const opacity = isHighlighted ? 0.6 : 0.15;
        const width = Math.max(0.01, Math.min(0.08, edge.weight * 0.02));

        const points = [
          new THREE.Vector3(sp[0], sp[1], sp[2]),
          new THREE.Vector3(tp[0], tp[1], tp[2]),
        ];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);

        return (
          <group key={`edge-${i}`}>
            {/* @ts-expect-error R3F <line> conflicts with SVG <line> */}
            <line geometry={geometry}>
              <lineBasicMaterial
                color={isHighlighted ? '#ffffff' : '#4488aa'}
                transparent
                opacity={opacity}
                linewidth={1}
              />
            </line>
            {isHighlighted && <FlowParticles edge={edge} />}
          </group>
        );
      })}
    </group>
  );
}

/** Nebula clouds for atmosphere */
function Nebula() {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    ref.current.rotation.y = state.clock.elapsedTime * 0.01;
  });

  const nebulaData = useMemo(
    () =>
      [
        { pos: [25, 10, -30] as [number, number, number], color: '#1a0033', scale: 18 },
        { pos: [-20, -8, 25] as [number, number, number], color: '#001a33', scale: 14 },
        { pos: [0, 20, -10] as [number, number, number], color: '#0d1a00', scale: 10 },
      ],
    []
  );

  return (
    <group ref={ref}>
      {nebulaData.map((n, i) => (
        <mesh key={i} position={n.pos}>
          <sphereGeometry args={[n.scale, 12, 12]} />
          <meshBasicMaterial
            color={n.color}
            transparent
            opacity={0.15}
            side={THREE.BackSide}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Camera controller with double-click focus */
function CameraController({
  focusTarget,
}: {
  focusTarget: [number, number, number] | null;
}) {
  const { camera } = useThree();
  const targetVec = useRef(new THREE.Vector3(0, 0, 0));

  useFrame(() => {
    if (focusTarget) {
      targetVec.current.set(focusTarget[0], focusTarget[1], focusTarget[2]);
      camera.position.lerp(
        new THREE.Vector3(
          focusTarget[0] + 8,
          focusTarget[1] + 4,
          focusTarget[2] + 8
        ),
        0.02
      );
    }
  });

  return null;
}

// ---------------------------------------------------------------------------
// WebGL availability check
// ---------------------------------------------------------------------------

function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2D fallback
// ---------------------------------------------------------------------------

function GalaxyFallback({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: GalaxyNode[];
  edges: GalaxyEdge[];
  onNodeClick?: (id: string) => void;
}) {
  // Simple 2D projection — use fibonacci sphere then flatten
  const positions = useMemo(() => {
    const ids = nodes.map((n) => n.id);
    return fibonacciSphere(ids, 200);
  }, [nodes]);

  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    positions.forEach((p) => m.set(p.id, { x: p.x + 300, y: p.y + 300 }));
    return m;
  }, [positions]);

  return (
    <div className="w-full h-full relative" style={{ background: '#000011' }}>
      <svg width="600" height="600" viewBox="0 0 600 600">
        {/* Edges */}
        {edges.map((e, i) => {
          const s = posMap.get(e.source);
          const t = posMap.get(e.target);
          if (!s || !t) return null;
          return (
            <line
              key={i}
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              stroke="#4488aa"
              strokeWidth={0.5}
              opacity={0.3}
            />
          );
        })}
        {/* Nodes */}
        {nodes.map((n) => {
          const p = posMap.get(n.id);
          if (!p) return null;
          const color = getNodeColor(n.capabilities);
          const r = Math.max(3, Math.min(10, (n.reputation || 1) * 2));
          return (
            <circle
              key={n.id}
              cx={p.x}
              cy={p.y}
              r={r}
              fill={color}
              opacity={n.online ? 1 : 0.4}
              stroke="#fff"
              strokeWidth={0.5}
              className="cursor-pointer"
              onClick={() => onNodeClick?.(n.id)}
            >
              <title>{n.name}</title>
            </circle>
          );
        })}
      </svg>
      <div className="absolute top-2 left-2 text-gray-400 text-xs">
        WebGL unavailable — showing 2D fallback
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner Scene (inside Canvas)
// ---------------------------------------------------------------------------

function GalaxyScene({
  nodes,
  edges,
  positions,
  selectedNode,
  hoveredNode,
  onSelectNode,
  onHoverNode,
  useInstanced,
}: {
  nodes: GalaxyNode[];
  edges: GalaxyEdge[];
  positions: Map<string, [number, number, number]>;
  selectedNode: string | null;
  hoveredNode: string | null;
  onSelectNode: (id: string) => void;
  onHoverNode: (id: string | null) => void;
  useInstanced: boolean;
}) {
  const [focusTarget, setFocusTarget] = useState<[number, number, number] | null>(null);

  const handleDoubleClick = useCallback(
    (nodeId: string) => {
      const pos = positions.get(nodeId);
      if (pos) setFocusTarget(pos);
    },
    [positions]
  );

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.15} />
      <pointLight position={[50, 50, 50]} intensity={0.8} color="#aaccff" />
      <pointLight position={[-30, -20, -40]} intensity={0.4} color="#ff88cc" />

      {/* Background stars */}
      <Stars
        radius={150}
        depth={60}
        count={4000}
        factor={3}
        saturation={0.1}
        fade
        speed={0.5}
      />

      {/* Nebula atmosphere */}
      <Nebula />

      {/* Agent nodes */}
      {useInstanced ? (
        <AgentInstances nodes={nodes} positions={positions} />
      ) : (
        nodes.map((node) => {
          const pos = positions.get(node.id) || [0, 0, 0];
          return (
            <AgentSphere
              key={node.id}
              node={node}
              position={pos}
              isSelected={selectedNode === node.id}
              isHovered={hoveredNode === node.id}
              onSelect={() => {
                onSelectNode(node.id);
                handleDoubleClick(node.id);
              }}
              onHover={(h) => onHoverNode(h ? node.id : null)}
            />
          );
        })
      )}

      {/* Edges */}
      <GalaxyEdges
        edges={edges}
        positions={positions}
        hoveredNode={hoveredNode}
      />

      {/* Camera */}
      <CameraController focusTarget={focusTarget} />
      <OrbitControls
        enableDamping
        dampingFactor={0.12}
        minDistance={5}
        maxDistance={120}
        enablePan
        panSpeed={0.8}
        rotateSpeed={0.6}
        zoomSpeed={1}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

const GalaxyView: React.FC<GalaxyViewProps> = ({
  nodes,
  edges,
  onNodeClick,
  onNodeHover,
  selectedNode,
  layout = 'sphere',
}) => {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [webGL] = useState(isWebGLAvailable);

  const positions = useMemo(
    () => computePositions(nodes, edges, layout),
    [nodes, edges, layout]
  );

  const useInstanced = nodes.length > 80;

  const handleSelectNode = useCallback(
    (id: string) => {
      onNodeClick?.(id);
    },
    [onNodeClick]
  );

  const handleHoverNode = useCallback(
    (id: string | null) => {
      setHoveredNode(id);
      onNodeHover?.(id);
    },
    [onNodeHover]
  );

  if (!webGL) {
    return (
      <div className="w-full h-full" style={{ background: '#000011' }}>
        <GalaxyFallback
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
        />
      </div>
    );
  }

  return (
    <div className="w-full h-full relative" style={{ background: '#000011' }}>
      <Canvas
        camera={{ position: [0, 20, 50], fov: 55, near: 0.1, far: 500 }}
        gl={{ antialias: true, alpha: false }}
        style={{ background: '#000011' }}
      >
        <GalaxyScene
          nodes={nodes}
          edges={edges}
          positions={positions}
          selectedNode={selectedNode ?? null}
          hoveredNode={hoveredNode}
          onSelectNode={handleSelectNode}
          onHoverNode={handleHoverNode}
          useInstanced={useInstanced}
        />
      </Canvas>
    </div>
  );
};

export default GalaxyView;
