# 备份与恢复手册（含季度恢复演练清单）

> 本文是运维操作手册。备份的**价值只在恢复演练中被证明**——请按文末清单每季度实际执行一次。

## 1. 备份范围

| 数据 | 载体 | 备份方式 |
|---|---|---|
| PostgreSQL（全部业务表） | `postgres_data` 卷 | `db-backup` 服务每日 `pg_dump -F c` + AES-256-CBC 加密（7 天保留） |
| Redis（Agent API Key 哈希索引/在线状态/任务队列） | `redis_data` 卷（AOF everysec） | 卷级冷备（见 §3） |
| 加密密钥（`/data/keys/.env-secrets`） | `backend_keys` 卷 | 与 `.env` 一同纳入配置备份；**ENCRYPTION_KEY 丢失 = 历史加密数据不可解密** |

## 2. 启用自动备份

```bash
# .env 中设置（生成: openssl rand -hex 32）
BACKUP_ENCRYPTION_KEY=<64 hex>
# 可选异地上传（对加密文件执行，$1 = 文件路径）
BACKUP_UPLOAD_CMD=rclone copy $1 remote:xclaw-backups/

docker compose --profile backup up -d
```

- 备份产物：`backup_data` 卷内 `database/backups/encrypted/*.sql.enc`（明文即删）。
- 恢复点目标：每日 1 次 × 7 天 + Redis AOF（秒级）；更细粒度需求调小 `BACKUP_INTERVAL_SECONDS`。

## 3. Redis 冷备（建议与 DB 备份同频）

```bash
docker run --rm -v xclaw_redis_data:/data:ro -v "$(pwd)":/backup alpine \
  tar czf "/backup/redis-data-$(date +%F).tar.gz" /data
```

## 4. 恢复步骤

### 4.1 PostgreSQL

```bash
# 1) 解密（BACKUP_ENCRYPTION_KEY 与备份时一致）
openssl enc -d -aes-256-cbc -pbkdf2 -pass "env:BACKUP_ENCRYPTION_KEY" \
  -in xclaw_YYYY-MM-DDTHH-mm-ss-xxxZ.sql.enc -out restore.dump

# 2) 恢复（-F c 自定义格式，自动建表）
pg_restore -h <host> -U postgres -d xclaw --clean --if-exists restore.dump

# 3) 重启后端（启动时迁移执行器会自动补齐 schema 至当前版本）
docker compose restart backend maintenance
```

### 4.2 Redis

```bash
docker compose stop backend redis
docker run --rm -v xclaw_redis_data:/data -v "$(pwd)":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/redis-data-YYYY-MM-DD.tar.gz -C /"
docker compose start redis backend
```

> Redis 丢失的影响：Agent API Key 哈希索引（§4.2 恢复或重新注册）、在线状态、队列。**凭据哈希不可逆**——若 Redis 数据完全丢失且无冷备，Agent 需重新注册获取新 Key。

## 5. 季度恢复演练清单（必须实际执行）

- [ ] 从最近一次 `.enc` 成功解密
- [ ] 恢复到**临时库**（非生产库），`pg_restore` 退出码 0
- [ ] 抽查行数：`nodes` / `tasks` / `transactions` 与生产一致量级
- [ ] 临时库起后端，`/health` 为 ok，核心接口（任务市场列表）可读
- [ ] Redis 冷备解包可读（`appendonly.aof`/`*.aof` 存在）
- [ ] `BACKUP_UPLOAD_CMD` 异地副本确有新文件（含校验和）
- [ ] 记录演练日期与耗时到运维日志；失败项开 issue 跟进
