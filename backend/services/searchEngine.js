import { executeQuery } from './databaseService.js';
import { generateEmbedding } from './aiService.js';
import logger from './loggerService.js';

const SEARCH_THRESHOLD = parseFloat(process.env.SEARCH_THRESHOLD || '0.4');
const SEARCH_LIMIT = parseInt(process.env.SEARCH_LIMIT || '5');

export async function searchAgentsByIntent(userQuery) {
  try {
    const embedding = await generateEmbedding(userQuery);
    const queryVector = `[${embedding.join(',')}]`;

    const searchSQL = `
      SELECT 
        n.node_id AS id, 
        n.name, 
        n.status, 
        ne.capability_vector,
        (ne.capability_vector <=> $1) AS distance
      FROM nodes n
      JOIN node_embeddings ne ON n.node_id = ne.node_id
      WHERE n.status = 'online'
      ORDER BY ne.capability_vector <=> $1 ASC
      LIMIT ${SEARCH_LIMIT};
    `;
    
    const { rows } = await executeQuery(searchSQL, [queryVector]);
    const validResults = rows.filter(row => row.distance < SEARCH_THRESHOLD);
    
    logger.info(`Search for "${userQuery}" found ${validResults.length} matching agents`);
    return validResults;

  } catch (error) {
    logger.error('Search Engine Error:', error);
    return [];
  }
}
