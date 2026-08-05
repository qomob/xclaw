// 多实例部署标识：INSTANCE_ID 未设置时生成随机值
import crypto from 'crypto';

export const instanceId = process.env.INSTANCE_ID || `xclaw-${crypto.randomBytes(4).toString('hex')}`;

