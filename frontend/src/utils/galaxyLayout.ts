/**
 * Galaxy Layout Algorithms for 3D star-map visualization.
 * Provides force-directed, spherical (Fibonacci), and hierarchy layouts.
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  weight: number;
}

/**
 * Fibonacci sphere uniform distribution.
 * Places N points roughly evenly on a sphere of given radius.
 */
export function fibonacciSphere(
  ids: string[],
  radius: number = 30
): LayoutNode[] {
  const n = ids.length;
  if (n === 0) return [];

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const nodes: LayoutNode[] = [];

  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1 || 1)) * 2; // -1 to 1
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;

    nodes.push({
      id: ids[i],
      x: Math.cos(theta) * radiusAtY * radius,
      y: y * radius,
      z: Math.sin(theta) * radiusAtY * radius,
      vx: 0,
      vy: 0,
      vz: 0,
    });
  }
  return nodes;
}

/**
 * Simple 3D force-directed layout.
 * Runs for `iterations` steps, returns stable positions.
 */
export function forceDirectedLayout(
  ids: string[],
  edges: LayoutEdge[],
  iterations: number = 100,
  radius: number = 30
): LayoutNode[] {
  const n = ids.length;
  if (n === 0) return [];

  // Initialize on sphere
  const nodes = fibonacciSphere(ids, radius);

  const nodeMap = new Map<string, LayoutNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const repulsionStrength = 800;
  const attractionStrength = 0.005;
  const centerStrength = 0.01;
  const damping = 0.92;

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations; // cooling

    // Reset forces
    for (const node of nodes) {
      node.vx = 0;
      node.vy = 0;
      node.vz = 0;
    }

    // Coulomb repulsion between all pairs
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        const distSq = Math.max(1, dx * dx + dy * dy + dz * dz);
        const dist = Math.sqrt(distSq);
        const force = (repulsionStrength * temp) / distSq;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;

        a.vx += fx;
        a.vy += fy;
        a.vz += fz;
        b.vx -= fx;
        b.vy -= fy;
        b.vz -= fz;
      }
    }

    // Hooke attraction along edges
    for (const edge of edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dz = target.z - source.z;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const force = dist * attractionStrength * edge.weight * temp;

      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fz = (dz / dist) * force;

      source.vx += fx;
      source.vy += fy;
      source.vz += fz;
      target.vx -= fx;
      target.vy -= fy;
      target.vz -= fz;
    }

    // Center gravity
    for (const node of nodes) {
      node.vx -= node.x * centerStrength;
      node.vy -= node.y * centerStrength;
      node.vz -= node.z * centerStrength;
    }

    // Apply velocities
    for (const node of nodes) {
      node.vx *= damping;
      node.vy *= damping;
      node.vz *= damping;
      node.x += node.vx;
      node.y += node.vy;
      node.z += node.vz;
    }
  }

  return nodes;
}

/**
 * Hierarchy layout — groups nodes by a key, arranges groups radially,
 * then fans out group members in a sub-cluster.
 */
export function hierarchyLayout(
  ids: string[],
  groupOf: (id: string) => number,
  radius: number = 30
): LayoutNode[] {
  const n = ids.length;
  if (n === 0) return [];

  // Group nodes
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const g = groupOf(id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(id);
  }

  const groupKeys = Array.from(groups.keys());
  const groupPositions = fibonacciSphere(
    groupKeys.map(String),
    radius
  );

  const result: LayoutNode[] = [];
  for (let gi = 0; gi < groupKeys.length; gi++) {
    const members = groups.get(groupKeys[gi])!;
    const gp = groupPositions[gi];
    const subR = Math.min(8, 2 + members.length * 0.5);
    const subNodes = fibonacciSphere(members, subR);
    for (const sn of subNodes) {
      result.push({
        id: sn.id,
        x: gp.x + sn.x,
        y: gp.y + sn.y,
        z: gp.z + sn.z,
        vx: 0,
        vy: 0,
        vz: 0,
      });
    }
  }
  return result;
}
