declare module 'react-globe.gl' {
  import { Component } from 'react';
  interface GlobeProps {
    ref?: any;
    backgroundColor?: string;
    globeImageUrl?: string;
    showAtmosphere?: boolean;
    showGraticules?: boolean;
    graticuleColor?: string;
    polygonsData?: any[];
    polygonStrokeColor?: (d: any) => string;
    polygonStrokeWidth?: number;
    polygonAltitude?: number;
    pointsData?: any[];
    pointColor?: (d: any) => string;
    pointRadius?: (d: any) => number;
    pointResolution?: number;
    pointTransparent?: boolean;
    pointOpacity?: number;
    onPointClick?: (d: any) => void;
    arcsData?: any[];
    arcStartLat?: string | ((d: any) => number);
    arcStartLng?: string | ((d: any) => number);
    arcEndLat?: string | ((d: any) => number);
    arcEndLng?: string | ((d: any) => number);
    arcColor?: string | ((d: any) => string);
    arcWidth?: number | ((d: any) => number);
    arcAltitude?: number | ((d: any) => number);
    arcResolution?: number;
    arcOpacity?: number;
    enableZoom?: boolean;
    enableRotation?: boolean;
    enableDragging?: boolean;
    maxZoom?: number;
    minZoom?: number;
    waitForGlobeReady?: boolean;
    animateIn?: boolean;
    renderPointsOfInterest?: boolean;
    controls?: Record<string, any>;
    width?: number | string;
    height?: number | string;
    [key: string]: any;
  }
  export default class Globe extends Component<GlobeProps> {}
}

declare module 'react-force-graph-3d' {
  import { Component, Ref } from 'react';
  interface ForceGraph3DProps {
    ref?: any;
    graphData?: { nodes: any[]; links: any[] };
    nodeLabel?: string | ((d: any) => string);
    nodeAutoColorBy?: string;
    nodeThreeObject?: (d: any) => any;
    onNodeClick?: (d: any) => void;
    onZoom?: (zoom: number) => void;
    linkWidth?: number | ((d: any) => number);
    linkColor?: string | ((d: any) => string);
    linkDirectionalParticles?: number;
    linkDirectionalParticleWidth?: number;
    backgroundColor?: string;
    forceEngine?: string;
    width?: number | string;
    height?: number | string;
    [key: string]: any;
  }
  interface ForceGraph3DRef {
    cameraPosition: (pos: { x: number; y: number; z: number }, lookAt: any, duration: number) => void;
  }
  export default class ForceGraph3D extends Component<ForceGraph3DProps> {}
}

// NOTE: Do NOT `declare module 'three'` here — @types/three@0.184.1 provides
// complete types.  A custom module declaration would shadow them and break
// THREE.Color, Vector3, BackSide, InstancedMesh, Group, etc.

declare module 'react-map-gl' {
  import { Component } from 'react';
  interface StaticMapProps {
    mapLib?: any;
    mapStyle?: string;
    preventStyleDiffing?: boolean;
    [key: string]: any;
  }
  export class StaticMap extends Component<StaticMapProps> {}
}
