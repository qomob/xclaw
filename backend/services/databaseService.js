import { getPostgres } from '../core/dependencies.js';
import logger from './loggerService.js';

export async function executeQuery(query, params = []) {
  const pool = getPostgres();
  const client = await pool.connect();
  try {
    const result = await client.query(query, params);
    return result;
  } catch (error) {
    logger.error('Database query failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

export async function insertNode(nodeData) {
  const { node_id, agent_name, source_url } = nodeData;
  const query = `
    INSERT INTO nodes (node_id, name, source_url)
    VALUES ($1, $2, $3)
    ON CONFLICT (node_id) DO UPDATE SET
      name = $2,
      source_url = $3,
      last_heartbeat = CURRENT_TIMESTAMP
    RETURNING node_id
  `;
  const result = await executeQuery(query, [node_id, agent_name, source_url]);
  return result.rows[0];
}

export async function insertOrUpdateEmbedding(node_id, vectorString) {
  const query = `
    INSERT INTO node_embeddings (node_id, capability_vector)
    VALUES ($1, $2)
    ON CONFLICT (node_id) DO UPDATE SET
      capability_vector = $2
  `;
  await executeQuery(query, [node_id, vectorString]);
}

export async function findNearestNodes(node_id, vectorString, limit = 5, distanceThreshold = 0.25) {
  const query = `
    SELECT 
      node_id AS target_id,
      (capability_vector <=> $2) AS distance
    FROM node_embeddings
    WHERE node_id != $1 AND (capability_vector <=> $2) < $3
    ORDER BY capability_vector <=> $2 ASC
    LIMIT $4
  `;
  const result = await executeQuery(query, [node_id, vectorString, distanceThreshold, limit]);
  return result.rows;
}

export async function getAllNodes() {
  const query = 'SELECT * FROM nodes WHERE status = \'online\'';
  const result = await executeQuery(query);
  return result.rows;
}
