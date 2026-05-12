// 力导向布局参数
const defaultConfig = {
  centerStrength: 0.1,
  gravity: 0.1,
  linkDistance: 10,
  linkStrength: 1,
  charge: -300,
  theta: 0.9,
  alpha: 1,
  alphaDecay: 0.028,
  alphaMin: 0.001
};

// 节点接口
interface Node {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  val: number;
}

// 连线接口
interface Link {
  source: string;
  target: string;
  weight: number;
}

// 消息接口
interface RawNode {
  id: string;
  val?: number;
  [key: string]: unknown;
}

interface MessageData {
  nodes?: RawNode[];
  links?: Link[];
  config?: Partial<typeof defaultConfig>;
  [key: string]: unknown;
}

interface Message {
  type: 'init' | 'tick' | 'config';
  data?: MessageData;
}

// 全局变量
let nodes: Node[] = [];
let links: Link[] = [];
let config = { ...defaultConfig };
let tickCount = 0;

// 初始化节点
function initNodes(rawNodes: RawNode[]): Node[] {
  return rawNodes.map(node => ({
    ...node,
    x: Math.random() * 20 - 10,
    y: Math.random() * 20 - 10,
    z: Math.random() * 20 - 10,
    vx: 0,
    vy: 0,
    vz: 0,
    val: node.val || 1
  }));
}

// 计算力导向布局
function tick() {
  if (config.alpha < config.alphaMin) {
    return;
  }

  // 计算电荷力
  for (let i = 0; i < nodes.length; i++) {
    const nodeA = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const nodeB = nodes[j];
      const dx = nodeB.x - nodeA.x;
      const dy = nodeB.y - nodeA.y;
      const dz = nodeB.z - nodeA.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      
      if (distance > 0) {
        const force = (config.charge * nodeA.val * nodeB.val) / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const fz = (dz / distance) * force;
        
        nodeA.vx -= fx;
        nodeA.vy -= fy;
        nodeA.vz -= fz;
        nodeB.vx += fx;
        nodeB.vy += fy;
        nodeB.vz += fz;
      }
    }
  }

  // 计算连线力
  for (const link of links) {
    const sourceNode = nodes.find(node => node.id === link.source);
    const targetNode = nodes.find(node => node.id === link.target);
    
    if (sourceNode && targetNode) {
      const dx = targetNode.x - sourceNode.x;
      const dy = targetNode.y - sourceNode.y;
      const dz = targetNode.z - sourceNode.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      
      if (distance > 0) {
        const force = (distance - config.linkDistance) * config.linkStrength * link.weight;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const fz = (dz / distance) * force;
        
        sourceNode.vx += fx;
        sourceNode.vy += fy;
        sourceNode.vz += fz;
        targetNode.vx -= fx;
        targetNode.vy -= fy;
        targetNode.vz -= fz;
      }
    }
  }

  // 计算中心引力
  for (const node of nodes) {
    const dx = node.x;
    const dy = node.y;
    const dz = node.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    if (distance > 0) {
      const force = distance * config.centerStrength;
      node.vx -= (dx / distance) * force;
      node.vy -= (dy / distance) * force;
      node.vz -= (dz / distance) * force;
    }
  }

  // 更新位置
  for (const node of nodes) {
    node.vx *= 0.9;
    node.vy *= 0.9;
    node.vz *= 0.9;
    node.x += node.vx * config.alpha;
    node.y += node.vy * config.alpha;
    node.z += node.vz * config.alpha;
  }

  // 衰减 alpha
  config.alpha *= 1 - config.alphaDecay;
  tickCount++;
}

// 处理消息
self.onmessage = (event: MessageEvent<Message>) => {
  const { type, data } = event.data;
  
  switch (type) {
    case 'init':
      if (data) {
        nodes = initNodes(data.nodes ?? []);
        links = data.links ?? [];
        config = { ...defaultConfig, ...(data.config ?? {}) };
        tickCount = 0;
      }
      break;
      
    case 'tick':
      tick();
      self.postMessage({
        type: 'tick',
        data: {
          nodes: nodes.map(node => ({
            id: node.id,
            x: node.x,
            y: node.y,
            z: node.z
          })),
          alpha: config.alpha,
          tickCount
        }
      });
      break;
      
    case 'config':
      config = { ...config, ...data };
      break;
  }
};
