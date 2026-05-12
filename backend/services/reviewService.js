import { getPostgres, getRedis } from '../core/dependencies.js';
import { formatResponse } from '../core/utils.js';
import logger from '../services/loggerService.js';

export async function addReview(skillId, reviewerId, { rating, comment, orderId = null }) {
  const pgPool = getPostgres();

  if (!rating || rating < 1 || rating > 5) {
    return formatResponse(false, null, '评分必须在1-5之间');
  }

  try {
    const client = await pgPool.connect();
    await client.query('BEGIN');

    const reviewerResult = await client.query(
      'SELECT reputation_score FROM nodes WHERE node_id = $1',
      [reviewerId]
    );

    if (reviewerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '评价者不存在');
    }

    const reputation = parseFloat(reviewerResult.rows[0].reputation_score) || 0.5;
    const weight = 0.5 + reputation * 0.5;
    const weightedRating = rating * weight;

    const result = await client.query(`
      INSERT INTO skill_reviews (skill_id, reviewer_id, order_id, rating, comment, weighted_rating)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (skill_id, reviewer_id) DO UPDATE SET
        rating = $4,
        comment = COALESCE($5, skill_reviews.comment),
        weighted_rating = $6,
        updated_at = NOW()
      RETURNING *
    `, [skillId, reviewerId, orderId, rating, comment, weightedRating]);

    const review = result.rows[0];

    const aggResult = await client.query(`
      SELECT
        COUNT(*) as count,
        AVG(weighted_rating) as weighted_avg,
        AVG(rating) as raw_avg
      FROM skill_reviews
      WHERE skill_id = $1
    `, [skillId]);

    const agg = aggResult.rows[0];
    await client.query(
      `UPDATE skills SET 
         avg_rating = ROUND($2::numeric, 2),
         review_count = $1,
         updated_at = NOW()
       WHERE id = $3`,
      [agg.count, agg.weighted_avg, skillId]
    );

    await client.query('COMMIT');
    client.release();

    logger.info('Review added', { skillId, reviewerId, rating, weightedRating });
    return formatResponse(true, review);
  } catch (error) {
    logger.error('Add review failed', { error: error.message, skillId, reviewerId });
    return formatResponse(false, null, '评价失败');
  }
}

export async function getSkillReviews(skillId, { limit = 20, offset = 0, sortBy = 'created_at' } = {}) {
  const pgPool = getPostgres();

  try {
    const validSortFields = ['created_at', 'rating', 'weighted_rating'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at';

    const result = await pgPool.query(`
      SELECT r.*, n.name as reviewer_name, n.reputation_score as reviewer_reputation
      FROM skill_reviews r
      LEFT JOIN nodes n ON r.reviewer_id = n.node_id
      WHERE r.skill_id = $1
      ORDER BY r.${sortField} DESC
      LIMIT $2 OFFSET $3
    `, [skillId, Math.min(limit, 100), Math.max(offset, 0)]);

    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get skill reviews failed', { error: error.message, skillId });
    return formatResponse(false, null, '获取评价列表失败');
  }
}

export async function getReviewerReviews(reviewerId, { limit = 20, offset = 0 } = {}) {
  const pgPool = getPostgres();

  try {
    const result = await pgPool.query(`
      SELECT r.*, s.name as skill_name, s.category, s.node_id as seller_id
      FROM skill_reviews r
      LEFT JOIN skills s ON r.skill_id = s.id
      WHERE r.reviewer_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `, [reviewerId, Math.min(limit, 100), Math.max(offset, 0)]);

    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get reviewer reviews failed', { error: error.message, reviewerId });
    return formatResponse(false, null, '获取评价历史失败');
  }
}

export async function getSkillRankings({ category, limit = 20, minReviews = 1 } = {}) {
  const pgPool = getPostgres();

  try {
    // 参数验证和清理
    const validatedMinReviews = Math.max(parseInt(minReviews) || 1, 0);
    const validatedLimit = Math.min(parseInt(limit) || 20, 50);
    
    let sql = `
      SELECT s.*, n.name as seller_name, n.reputation_score as seller_reputation,
             s.review_count, s.avg_rating, s.sales_count, s.total_revenue
      FROM skills s
      LEFT JOIN nodes n ON s.node_id = n.node_id
      WHERE s.is_listed = TRUE AND s.review_count >= $1
    `;
    const params = [validatedMinReviews];

    if (category) {
      params.push(category);
      sql += ` AND s.category = $${params.length}`;
    }

    sql += ` ORDER BY s.avg_rating DESC NULLS LAST, s.sales_count DESC`;

    params.push(validatedLimit);
    sql += ` LIMIT $${params.length}`;

    const result = await pgPool.query(sql, params);
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get skill rankings failed', { error: error.message });
    return formatResponse(false, null, '获取排行榜失败');
  }
}

export async function getTopRatedSkills(limit = 10) {
  const pgPool = getPostgres();

  try {
    const result = await pgPool.query(`
      SELECT s.*, n.name as seller_name,
             s.avg_rating, s.review_count, s.sales_count
      FROM skills s
      LEFT JOIN nodes n ON s.node_id = n.node_id
      WHERE s.is_listed = TRUE AND s.avg_rating >= 3.0
      ORDER BY s.avg_rating DESC, s.review_count DESC
      LIMIT $1
    `, [limit]);

    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get top rated skills failed', { error: error.message });
    return formatResponse(false, null, '获取高分技能失败');
  }
}

export async function getCategoryRankings() {
  const pgPool = getPostgres();

  try {
    const result = await pgPool.query(`
      SELECT category,
             COUNT(*) as skill_count,
             COUNT(*) FILTER (WHERE avg_rating >= 4.0) as top_rated_count,
             COALESCE(AVG(avg_rating), 0) as category_avg_rating,
             COALESCE(SUM(sales_count), 0) as total_sales,
             COALESCE(SUM(total_revenue), 0) as total_revenue
      FROM skills
      WHERE is_listed = TRUE
      GROUP BY category
      HAVING COUNT(*) >= 1
      ORDER BY category_avg_rating DESC NULLS LAST, total_sales DESC
    `);

    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get category rankings failed', { error: error.message });
    return formatResponse(false, null, '获取分类排行失败');
  }
}
