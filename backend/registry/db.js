import { getPostgres } from '../core/dependencies.js';

export async function initDatabase() {
  const pgPool = getPostgres();

  try {
    await pgPool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pgPool.query('CREATE EXTENSION IF NOT EXISTS vector');

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS nodes (
        node_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        capabilities TEXT NOT NULL,
        tags JSONB DEFAULT '[]',
        public_key TEXT NOT NULL,
        endpoint_url VARCHAR(255),
        latitude DOUBLE PRECISION DEFAULT 0,
        longitude DOUBLE PRECISION DEFAULT 0,
        status VARCHAR(50) DEFAULT 'offline',
        reputation_score DECIMAL(3, 2) DEFAULT 1.0,
        total_earnings DECIMAL(14, 4) DEFAULT 0,
        last_heartbeat TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS skills (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        category VARCHAR(100) NOT NULL,
        version VARCHAR(50) NOT NULL,
        node_id UUID REFERENCES nodes(node_id),
        schema JSONB DEFAULT '{}',
        embedding VECTOR(256),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        type VARCHAR(255) NOT NULL,
        payload JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'pending',
        node_id UUID REFERENCES nodes(node_id),
        skill_id UUID REFERENCES skills(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS task_logs (
        log_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        node_id UUID REFERENCES nodes(node_id),
        action VARCHAR(255),
        details TEXT,
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        task_id UUID REFERENCES tasks(id),
        skill_id UUID REFERENCES skills(id),
        node_id UUID REFERENCES nodes(node_id),
        amount DECIMAL(10, 4) NOT NULL,
        type VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS node_embeddings (
        node_id UUID REFERENCES nodes(node_id) ON DELETE CASCADE,
        capability_vector VECTOR(768),
        PRIMARY KEY (node_id)
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS agent_memories (
        memory_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        agent_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL DEFAULT 'interaction',
        content TEXT NOT NULL,
        related_agent_id UUID REFERENCES nodes(node_id) ON DELETE SET NULL,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        importance DECIMAL(3, 2) DEFAULT 0.5,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS agent_relationships (
        relationship_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        agent_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
        related_agent_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL DEFAULT 'neutral',
        interaction_count INTEGER DEFAULT 0,
        avg_rating DECIMAL(3, 2) DEFAULT 0.5,
        last_interaction_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(agent_id, related_agent_id)
      )
    `);

    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_nodes_tags ON nodes USING GIN (tags)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_nodes_reputation ON nodes(reputation_score)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_skills_node_id ON skills(node_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_node_id ON tasks(node_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_node_id ON transactions(node_id)`);
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS idx_node_embeddings_vector
      ON node_embeddings
      USING hnsw (capability_vector vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_id ON agent_memories(agent_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_memories_type ON agent_memories(type)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_memories_importance ON agent_memories(importance DESC)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_memories_created ON agent_memories(created_at DESC)`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        message_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        sender_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
        receiver_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
        type VARCHAR(50) DEFAULT 'info',
        content TEXT NOT NULL,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_messages_receiver ON agent_messages(receiver_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_messages_sender ON agent_messages(sender_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_messages_read ON agent_messages(receiver_id, read) WHERE read = FALSE`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at DESC)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_relationships_agent ON agent_relationships(agent_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_relationships_related ON agent_relationships(related_agent_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_agent_relationships_type ON agent_relationships(type)`);

    await pgPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = 'total_earnings') THEN
          ALTER TABLE nodes ADD COLUMN total_earnings DECIMAL(16, 2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'idempotency_key') THEN
          ALTER TABLE transactions ADD COLUMN idempotency_key VARCHAR(255) UNIQUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'operator_id') THEN
          ALTER TABLE transactions ADD COLUMN operator_id UUID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'reason') THEN
          ALTER TABLE transactions ADD COLUMN reason VARCHAR(500);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'ip_address') THEN
          ALTER TABLE transactions ADD COLUMN ip_address VARCHAR(45);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'metadata') THEN
          ALTER TABLE transactions ADD COLUMN metadata JSONB DEFAULT '{}';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'reward_amount') THEN
          ALTER TABLE tasks ADD COLUMN reward_amount DECIMAL(10, 2);
        END IF;
      END
      $$
    `);

    console.log('数据库初始化完成');
  } catch (error) {
    console.error('数据库初始化错误:', error);
  }
}

export async function clearDatabase() {
  const pgPool = getPostgres();

  try {
    await pgPool.query('DELETE FROM task_logs');
    await pgPool.query('DELETE FROM transactions');
    await pgPool.query('DELETE FROM tasks');
    await pgPool.query('DELETE FROM skills');
    await pgPool.query('DELETE FROM nodes');
    console.log('数据库清理完成');
  } catch (error) {
    console.error('数据库清理错误:', error);
  }
}
