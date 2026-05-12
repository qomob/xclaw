import { insertNode, insertOrUpdateEmbedding, findNearestNodes } from './databaseService.js';
import dotenv from 'dotenv';
import cacheService from './cacheService.js';
import logger from './loggerService.js';
import { generateEmbedding } from './aiService.js';

dotenv.config();

/**
 * 获取文本的向量表示
 * @param {string} text - 要嵌入的文本
 * @returns {Promise<Array>} 向量表示
 */
export async function getEmbedding(text) {
  return await generateEmbedding(text);
}

/**
 * 节点注册并计算拓扑连线 (Edges)
 * @param {string} nodeId - 新节点 UUID
 * @param {Object} agentData - 从解析器获取的 Agent 数据
 * @returns {Promise<Array>} 新生成的连线
 */
export async function registerNodeAndGenerateEdges(nodeId, agentData) {
  try {
    // 1. 调用大模型获取能力向量
    const capabilities = agentData.capabilities_summary;
    const vectorData = await getEmbedding(capabilities);
    // pgvector 要求的数组格式为 '[0.1, 0.2, ...]'
    const vectorString = `[${vectorData.join(',')}]`;

    try {
      // 2. 插入节点信息
      await insertNode({
        node_id: nodeId,
        agent_name: agentData.agent_name,
        source_url: agentData.source_url || null
      });

      // 3. 插入或更新节点的向量表示
      await insertOrUpdateEmbedding(nodeId, vectorString);

      // 4. 核心：执行向量近似最近邻搜索 (ANN) 计算连线
      // 寻找余弦距离 < 0.25 (即相似度 > 0.75) 的前 5 个节点
      const nearestNodes = await findNearestNodes(nodeId, vectorString, 5, 0.25);

      // 5. 构造边数据给前端 (WebSocket 广播下发)
      const newEdges = nearestNodes.map(row => ({
        source: nodeId,
        target: row.target_id,
        // 将距离转化为物理引擎的连线强度/厚度
        weight: 1 - row.distance 
      }));

      logger.info('Topology edges generated', { nodeId, edgeCount: newEdges.length });
      return newEdges;
    } catch (dbError) {
      logger.error('Database operation failed', { error: dbError.message, stack: dbError.stack });
      // 数据库操作失败时，返回空数组，确保应用不会崩溃
      return [];
    }

  } catch (err) {
    logger.error('Failed to register node and generate edges', { error: err.message, stack: err.stack });
    // 发生错误时，返回空数组，确保应用不会崩溃
    return [];
  }
}
