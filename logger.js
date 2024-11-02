import winston from 'winston';
import path from 'path';

// Create logs directory if it doesn't exist
import fs from 'fs';

const logDir = 'logs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ 
          filename: path.join(logDir, 'migration.log'),
          level: 'debug',
          maxsize: 5242880,
          maxFiles: 5,
          tailable: true
      })
    ]
});

export function setVerbosity(verbose) {
    logger.level = verbose ? 'debug' : 'info';
}
