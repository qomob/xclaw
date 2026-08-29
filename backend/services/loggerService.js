// 日志服务
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

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

// 文件日志按天轮转（保留 14 天、单文件上限后归档），防止 backend_logs 卷内无界增长
const fileTransports = [
  new DailyRotateFile({
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxSize: '50m',
    maxFiles: '14d',
    zippedArchive: true
  }),
  new DailyRotateFile({
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '100m',
    maxFiles: '14d',
    zippedArchive: true
  })
];

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new transports.Console(),
    ...fileTransports
  ]
});

export default logger;
