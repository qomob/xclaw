// 系统配置文件
import dotenv from 'dotenv';
dotenv.config();

const config = {
  // 服务器配置
  server: {
    port: process.env.PORT || 8080,
    host: process.env.HOST || '0.0.0.0',
    publicUrl: process.env.PUBLIC_URL || '',
    wsPublicUrl: process.env.WS_PUBLIC_URL || ''
  },
  
  // 数据库配置
  database: {
    postgres: {
      connectionString: process.env.DATABASE_URL,
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'xclaw'
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD
    }
  },
  
  // 安全配置
  security: {
    jwtSecret: process.env.JWT_SECRET,
    apiKey: process.env.API_KEY,
    adminApiKey: process.env.ADMIN_API_KEY || process.env.API_KEY,
    tokenExpiry: parseInt(process.env.TOKEN_EXPIRY) || 86400, // 24小时
    corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['https://xclaw.network', 'https://skill.xclaw.network']
  },
  
  // 地理配置
  geo: {
    defaultLatitude: 0,
    defaultLongitude: 0,
    dbPath: process.env.GEOIP_DB_PATH || ''
  },
  
  // 任务调度配置
  task: {
    timeout: 30000, // 30秒
    maxRetries: 3
  },
  
  // 心跳配置
  heartbeat: {
    interval: 30000, // 30秒
    timeout: 60000 // 60秒
  },
  
  // 速率限制配置
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15分钟
    max: 500, // 每IP 15分钟500次（前端轮询+页面加载的安全余量）
    skill: {
      windowMs: 15 * 60 * 1000,
      max: 30
    }
  }
};

export default config;
