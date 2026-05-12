// 日志服务
import { createLogger, format, transports } from 'winston';

const { combine, timestamp, printf, colorize, align } = format;

const logFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  colorize(),
  align(),
  printf((info) => {
    const { timestamp, level, message, ...args } = info;
    
    // 敏感字段脱敏处理
    const maskSensitiveData = (obj) => {
      const sensitiveKeys = ['apiKey', 'API_KEY', 'password', 'ENCRYPTION_KEY', 'jwtSecret', 'DATABASE_URL', 'token'];
      const masked = { ...obj };
      for (const key in masked) {
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
          masked[key] = '********';
        } else if (typeof masked[key] === 'object' && masked[key] !== null) {
          masked[key] = maskSensitiveData(masked[key]);
        }
      }
      return masked;
    };

    const cleanArgs = maskSensitiveData(args);
    return `${timestamp} ${level}: ${message} ${Object.keys(cleanArgs).length ? JSON.stringify(cleanArgs, null, 2) : ''}`;
  })
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new transports.Console(),
    new transports.File({
      filename: 'logs/error.log',
      level: 'error'
    }),
    new transports.File({
      filename: 'logs/combined.log'
    })
  ]
});

export default logger;
