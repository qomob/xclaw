// 技能注册管理文件
import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, formatResponse } from '../core/utils.js';
import { scanSkill } from '../services/skillScanner.js';
import eventBus from '../services/eventBus.js';

// 注册技能
export async function registerSkill(skillData, nodeId) {
  const pgPool = getPostgres();
  const redisClient = getRedis();
  
  try {
    // 生成技能 ID
    const skillId = generateUUID(`${nodeId}:${skillData.name}:${skillData.version}`);
    
    // 检查技能是否已存在
    const existingSkill = await pgPool.query(
      'SELECT id FROM skills WHERE id = $1',
      [skillId]
    );
    
    if (existingSkill.rows.length > 0) {
      // 更新现有技能
      await pgPool.query(
        `UPDATE skills SET 
         name = $1, 
         description = $2, 
         category = $3, 
         version = $4, 
         schema = $5, 
         updated_at = NOW() 
         WHERE id = $6`,
        [
          skillData.name,
          skillData.description,
          skillData.category,
          skillData.version,
          skillData.schema || {},
          skillId
        ]
      );
    } else {
      // 创建新技能
      await pgPool.query(
        `INSERT INTO skills (
         id, name, description, category, version, node_id, schema
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          skillId,
          skillData.name,
          skillData.description,
          skillData.category,
          skillData.version,
          nodeId,
          skillData.schema || {}
        ]
      );
    }
    
    // 缓存技能信息到 Redis
    await redisClient.hset(
      `skill:${skillId}`,
      {
        id: skillId,
        name: skillData.name,
        category: skillData.category,
        node_id: nodeId
      }
    );
    
    // 将技能添加到分类集合
    await redisClient.sadd(`skills:category:${skillData.category}`, skillId);
    
    // 将技能添加到节点技能集合
    await redisClient.sadd(`node:${nodeId}:skills`, skillId);

    // ── 自动安全扫描（静态 + 可选沙箱试跑）────────────────────────────
    // 高风险（注入/密钥/外传/欺诈/提示词注入）→ 直接拒绝并隐藏，无法上架
    const scan = await scanSkill({
      ...skillData,
      id: skillId,
      node_id: nodeId,
    });
    const reviewStatus = scan.verdict === 'reject' ? 'rejected' : 'pending';
    const reviewNote = scan.verdict === 'reject'
      ? `自动扫描拒绝：${scan.flags.map(f => `[${f.rule}] ${f.hint}`).join('；')}`
      : null;
    await pgPool.query(
      `UPDATE skills SET scan_result = $2, review_status = $3, review_note = $4, updated_at = NOW() WHERE id = $1`,
      [skillId, JSON.stringify(scan), reviewStatus, reviewNote]
    );
    
    eventBus.emit('skill.registered', { skill_id: skillId, name: skillData.name, category: skillData.category, node_id: nodeId }, { sourceId: nodeId });
    return formatResponse(true, {
      skill_id: skillId,
      status: 'registered',
      review_status: reviewStatus,
      scan_verdict: scan.verdict,
      scan_flags: scan.flags,
      scan_note: reviewNote,
    });
  } catch (error) {
    console.error('技能注册错误:', error);
    return formatResponse(false, null, '技能注册失败');
  }
}

// 获取技能信息
export async function getSkill(skillId) {
  const pgPool = getPostgres();
  
  try {
    const result = await pgPool.query(
      'SELECT * FROM skills WHERE id = $1',
      [skillId]
    );
    
    if (result.rows.length === 0) {
      return formatResponse(false, null, '技能不存在');
    }
    
    return formatResponse(true, result.rows[0]);
  } catch (error) {
    console.error('获取技能信息错误:', error);
    return formatResponse(false, null, '获取技能信息失败');
  }
}

// 搜索技能
export async function searchSkills(query, category, limit = 10) {
  const pgPool = getPostgres();

  try {
    let sql = 'SELECT id, name, description, category, version, node_id FROM skills';
    const params = [];
    const conditions = [];

    if (query && query.trim()) {
      const searchTerm = `%${query.trim()}%`;
      conditions.push(`(name ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`);
      params.push(searchTerm);
    }

    if (category) {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC';

    sql += ` LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pgPool.query(sql, params);

    return formatResponse(true, result.rows);
  } catch (error) {
    console.error('搜索技能错误:', error);
    return formatResponse(false, null, '搜索技能失败');
  }
}

// 获取节点的技能列表
export async function getNodeSkills(nodeId) {
  const pgPool = getPostgres();
  const redisClient = getRedis();
  
  try {
    // 先尝试从 Redis 获取
    const skillIds = await redisClient.smembers(`node:${nodeId}:skills`);
    
    if (skillIds.length > 0) {
      const skills = [];
      for (const skillId of skillIds) {
        const skillInfo = await redisClient.hgetall(`skill:${skillId}`);
        if (skillInfo) {
          skills.push(skillInfo);
        }
      }
      return formatResponse(true, skills);
    }
    
    // Redis 中没有，从数据库获取
    const result = await pgPool.query(
      'SELECT id, name, description, category, version FROM skills WHERE node_id = $1',
      [nodeId]
    );
    
    // 缓存到 Redis
    for (const skill of result.rows) {
      await redisClient.hset(
        `skill:${skill.id}`,
        {
          id: skill.id,
          name: skill.name,
          category: skill.category,
          node_id: nodeId
        }
      );
      await redisClient.sadd(`node:${nodeId}:skills`, skill.id);
      await redisClient.sadd(`skills:category:${skill.category}`, skill.id);
    }
    
    return formatResponse(true, result.rows);
  } catch (error) {
    console.error('获取节点技能错误:', error);
    return formatResponse(false, null, '获取节点技能失败');
  }
}

// 删除技能
export async function deleteSkill(skillId) {
  const pgPool = getPostgres();
  const redisClient = getRedis();
  
  try {
    // 获取技能信息
    const skillInfo = await pgPool.query(
      'SELECT node_id, category FROM skills WHERE id = $1',
      [skillId]
    );
    
    if (skillInfo.rows.length === 0) {
      return formatResponse(false, null, '技能不存在');
    }
    
    const { node_id, category } = skillInfo.rows[0];
    
    // 删除技能
    await pgPool.query('DELETE FROM skills WHERE id = $1', [skillId]);
    
    // 删除 Redis 缓存
    await redisClient.del(`skill:${skillId}`);
    await redisClient.srem(`skills:category:${category}`, skillId);
    await redisClient.srem(`node:${node_id}:skills`, skillId);
    
    return formatResponse(true, { message: '技能删除成功' });
  } catch (error) {
    console.error('删除技能错误:', error);
    return formatResponse(false, null, '删除技能失败');
  }
}

// 获取技能分类列表
export async function getSkillCategories() {
  const redisClient = getRedis();
  
  try {
    // 从 Redis 获取分类列表
    const categories = await redisClient.smembers('skill_categories');
    
    if (categories.length === 0) {
      // Redis 中没有，从数据库获取
      const pgPool = getPostgres();
      const result = await pgPool.query('SELECT DISTINCT category FROM skills');
      
      const dbCategories = result.rows.map(row => row.category);
      
      // 缓存到 Redis
      for (const category of dbCategories) {
        await redisClient.sadd('skill_categories', category);
      }
      
      return formatResponse(true, dbCategories);
    }
    
    return formatResponse(true, categories);
  } catch (error) {
    console.error('获取技能分类错误:', error);
    return formatResponse(false, null, '获取技能分类失败');
  }
}
