#!/usr/bin/env node

/**
 * 数据库备份脚本
 * 用于定期备份 PostgreSQL 数据库
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

// 数据库连接信息
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('❌ 未找到 DATABASE_URL 环境变量');
  process.exit(1);
}

// 解析数据库连接信息
const url = new URL(databaseUrl);
const dbName = url.pathname.slice(1);
const user = url.username;
const password = url.password;
const host = url.hostname;
const port = url.port || 5432;

// 备份目录
const backupDir = path.resolve(process.cwd(), '../../database/backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// 备份文件名
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFileName = `${dbName}_${timestamp}.sql`;
const backupPath = path.join(backupDir, backupFileName);

// 设置 PGPASSWORD 环境变量
process.env.PGPASSWORD = password;

console.log(`📦 开始备份数据库 ${dbName}...`);

try {
  // 执行 pg_dump 命令
  const command = `pg_dump -h ${host} -p ${port} -U ${user} -d ${dbName} -F c -f ${backupPath}`;
  execSync(command, { stdio: 'inherit' });
  
  console.log(`✅ 数据库备份成功: ${backupPath}`);
  
  // 清理旧备份（保留最近 7 天的备份）
  cleanupOldBackups(backupDir, 7);
  
} catch (error) {
  console.error('❌ 数据库备份失败:', error.message);
  process.exit(1);
} finally {
  // 清除 PGPASSWORD 环境变量
  delete process.env.PGPASSWORD;
}

/**
 * 清理旧备份
 * @param {string} backupDir - 备份目录
 * @param {number} daysToKeep - 保留天数
 */
function cleanupOldBackups(backupDir, daysToKeep) {
  const files = fs.readdirSync(backupDir);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  
  let deletedCount = 0;
  
  files.forEach(file => {
    const filePath = path.join(backupDir, file);
    const stats = fs.statSync(filePath);
    
    if (stats.isFile() && stats.mtime < cutoffDate) {
      fs.unlinkSync(filePath);
      deletedCount++;
    }
  });
  
  if (deletedCount > 0) {
    console.log(`🗑️  清理了 ${deletedCount} 个旧备份文件`);
  }
}
