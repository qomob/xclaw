// 节点接口
export interface Node {
  id: string;
  name: string;
  group: number;
  val: number;
  tags: string[];
  x?: number;
  y?: number;
  z?: number;
}

// 聚类结果接口
export interface Cluster {
  id: string;
  nodes: Node[];
  center: {
    x: number;
    y: number;
    z: number;
  };
  size: number;
  group: number;
}

/**
 * K-means 聚类算法
 * @param nodes 节点数组
 * @param k 聚类数量
 * @param maxIterations 最大迭代次数
 * @returns 聚类结果
 */
export function kmeans(nodes: Node[], k: number, maxIterations: number = 100): Cluster[] {
  if (nodes.length === 0) return [];
  if (nodes.length <= k) {
    return nodes.map((node, index) => ({
      id: `cluster-${index}`,
      nodes: [node],
      center: {
        x: node.x || 0,
        y: node.y || 0,
        z: node.z || 0
      },
      size: 1,
      group: node.group
    }));
  }

  // 初始化聚类中心
  const centers = initializeCenters(nodes, k);
  let clusters: Cluster[] = [];
  let iteration = 0;

  while (iteration < maxIterations) {
    // 分配节点到最近的聚类中心
    clusters = assignNodesToClusters(nodes, centers);
    
    // 更新聚类中心
    const newCenters = updateCenters(clusters);
    
    // 检查是否收敛
    if (hasConverged(centers, newCenters)) {
      break;
    }
    
    centers.forEach((center, index) => {
      center.x = newCenters[index].x;
      center.y = newCenters[index].y;
      center.z = newCenters[index].z;
    });
    
    iteration++;
  }

  return clusters;
}

/**
 * 初始化聚类中心
 */
function initializeCenters(nodes: Node[], k: number) {
  const centers = [];
  const usedIndices = new Set<number>();
  
  // 随机选择 k 个节点作为初始中心
  while (centers.length < k) {
    const index = Math.floor(Math.random() * nodes.length);
    if (!usedIndices.has(index)) {
      usedIndices.add(index);
      centers.push({
        x: nodes[index].x || 0,
        y: nodes[index].y || 0,
        z: nodes[index].z || 0
      });
    }
  }
  
  return centers;
}

/**
 * 分配节点到最近的聚类中心
 */
function assignNodesToClusters(nodes: Node[], centers: { x: number; y: number; z: number }[]) {
  const clusters: Cluster[] = centers.map((_, index) => ({
    id: `cluster-${index}`,
    nodes: [],
    center: { ...centers[index] },
    size: 0,
    group: 0
  }));

  nodes.forEach(node => {
    let minDistance = Infinity;
    let closestClusterIndex = 0;

    centers.forEach((center, index) => {
      const distance = calculateDistance(
        node.x || 0,
        node.y || 0,
        node.z || 0,
        center.x,
        center.y,
        center.z
      );

      if (distance < minDistance) {
        minDistance = distance;
        closestClusterIndex = index;
      }
    });

    clusters[closestClusterIndex].nodes.push(node);
    clusters[closestClusterIndex].size++;
    // 使用第一个节点的 group 作为聚类的 group
    if (clusters[closestClusterIndex].nodes.length === 1) {
      clusters[closestClusterIndex].group = node.group;
    }
  });

  return clusters;
}

/**
 * 更新聚类中心
 */
function updateCenters(clusters: Cluster[]) {
  return clusters.map(cluster => {
    if (cluster.nodes.length === 0) {
      return cluster.center;
    }

    const sum = cluster.nodes.reduce(
      (acc, node) => {
        return {
          x: acc.x + (node.x || 0),
          y: acc.y + (node.y || 0),
          z: acc.z + (node.z || 0)
        };
      },
      { x: 0, y: 0, z: 0 }
    );

    return {
      x: sum.x / cluster.nodes.length,
      y: sum.y / cluster.nodes.length,
      z: sum.z / cluster.nodes.length
    };
  });
}

/**
 * 计算两个点之间的距离
 */
function calculateDistance(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 检查是否收敛
 */
function hasConverged(
  oldCenters: { x: number; y: number; z: number }[],
  newCenters: { x: number; y: number; z: number }[]
) {
  const threshold = 0.01;
  
  for (let i = 0; i < oldCenters.length; i++) {
    const distance = calculateDistance(
      oldCenters[i].x,
      oldCenters[i].y,
      oldCenters[i].z,
      newCenters[i].x,
      newCenters[i].y,
      newCenters[i].z
    );
    
    if (distance > threshold) {
      return false;
    }
  }
  
  return true;
}

/**
 * 根据缩放级别获取聚类
 * @param nodes 节点数组
 * @param zoomLevel 缩放级别
 * @returns 聚类结果
 */
export function getClustersByZoomLevel(nodes: Node[], zoomLevel: number): Cluster[] {
  // 根据缩放级别动态调整聚类数量
  const maxClusters = Math.min(50, Math.max(5, Math.floor(nodes.length / 10)));
  const clusterCount = Math.max(1, Math.floor(maxClusters * (1 - zoomLevel / 10)));
  
  return kmeans(nodes, clusterCount);
}

/**
 * 将聚类转换为可渲染的节点
 * @param clusters 聚类数组
 * @returns 可渲染的节点数组
 */
export function clustersToNodes(clusters: Cluster[]): Node[] {
  return clusters.map(cluster => ({
    id: cluster.id,
    name: `Cluster ${cluster.id.split('-')[1]} (${cluster.nodes.length} nodes)`,
    group: cluster.group,
    val: cluster.size * 2, // 聚类大小基于包含的节点数量
    tags: ['cluster'],
    x: cluster.center.x,
    y: cluster.center.y,
    z: cluster.center.z
  }));
}
