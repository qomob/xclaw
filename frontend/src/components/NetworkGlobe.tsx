import React, { useEffect, useRef, useState } from 'react';
import Globe from 'react-globe.gl';

interface Node {
  id: string;
  lat: number;
  lng: number;
  group: number;
  val: number;
  name: string;
  tags: string[];
  online?: boolean;
}

interface Link {
  source: string;
  target: string;
  sourceLat: number;
  sourceLng: number;
  targetLat: number;
  targetLng: number;
  weight: number;
  active?: boolean;
}

interface GraphData {
  nodes: Node[];
  links: Link[];
}

interface NetworkGlobeProps {
  graphData: GraphData;
  highlightNodes: Set<string>;
  onNodeClick: (node: Node) => void;
}

export default function NetworkGlobe({ graphData, highlightNodes, onNodeClick }: NetworkGlobeProps) {
  const globeRef = useRef<any>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [time, setTime] = useState(0);

  useEffect(() => {
    if (!graphData || !Array.isArray(graphData.nodes)) {
      setNodes([]);
      setLinks([]);
      return;
    }

    setNodes(graphData.nodes);

    const formattedLinks = graphData.links.map(link => {
      const sourceNode = graphData.nodes.find(n => n.id === link.source);
      const targetNode = graphData.nodes.find(n => n.id === link.target);

      return {
        ...link,
        sourceLat: sourceNode?.lat || 0,
        sourceLng: sourceNode?.lng || 0,
        targetLat: targetNode?.lat || 0,
        targetLng: targetNode?.lng || 0,
      };
    });
    setLinks(formattedLinks);
  }, [graphData]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(prevTime => prevTime + 0.01);
    }, 30);

    return () => clearInterval(interval);
  }, []);

  const getNodeColor = (node: Node) => {
    if (highlightNodes.has(node.id)) {
      return '#ffffff';
    }

    switch (node.group) {
      case 1: return '#ff00ff';
      case 2: return '#00ffff';
      case 3: return '#00ff00';
      case 4: return '#ffff00';
      default: return '#00ffff';
    }
  };

  const getNodeSize = (node: Node) => {
    return node.val * 0.8;
  };

  const getLinkColor = (link: Link) => {
    return link.active ? '#00ffff' : '#666666';
  };

  const getLinkWidth = (link: Link) => {
    return link.weight * 0.5;
  };

  const getLinkDashArray = (link: Link) => {
    const offset = (time * 50) % 20;
    return `20 ${offset}`;
  };

  const getNodeAltitude = (node: Node) => {
    return 0.05 + Math.sin(time * 2 + parseInt(node.id.split('_')[1]) % 10) * 0.02;
  };

  const [countries, setCountries] = useState<any[]>([]);

  useEffect(() => {
    fetch('//unpkg.com/world-atlas@1.1.4/world/110m.json')
      .then(res => res.json())
      .then(data => {
        const { features } = data;
        setCountries(features);
      })
      .catch(error => console.error('Error loading countries data:', error));
  }, []);

  return (
    <div className="w-full h-screen bg-black overflow-hidden">
      <Globe
        ref={globeRef}

        backgroundColor="#000000"
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
        showAtmosphere={false}
        showGraticules={true}
        graticuleColor="rgba(255, 255, 255, 0.1)"

        polygonsData={countries}
        polygonStrokeColor={() => 'rgba(255, 255, 255, 0.3)'}
        polygonStrokeWidth={0.5}
        polygonAltitude={0.001}

        pointsData={nodes}
        pointColor={getNodeColor}
        pointRadius={getNodeSize}
        pointResolution={8}
        pointTransparent={true}
        pointOpacity={0.8}
        onPointClick={(point) => onNodeClick(point)}

        arcsData={links}
        arcStartLat="sourceLat"
        arcStartLng="sourceLng"
        arcEndLat="targetLat"
        arcEndLng="targetLng"
        arcColor={getLinkColor}
        arcWidth={getLinkWidth}
        arcAltitude={0.1}
        arcResolution={20}
        arcOpacity={0.6}

        enableZoom={true}
        enableRotation={true}
        enableDragging={true}
        maxZoom={5}
        minZoom={0.5}

        waitForGlobeReady={true}
        animateIn={true}
        renderPointsOfInterest={false}

        controls={{
          autoRotate: true,
          autoRotateSpeed: 0.5,
          zoomSpeed: 1.5,
          rotateSpeed: 1.5,
        }}
      />
    </div>
  );
}
