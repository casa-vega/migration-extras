const winston = require('winston');
const path = require('path');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logDir = 'logs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const logger = winston.createLogger({
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

function setVerbosity(verbose) {
    logger.level = verbose ? 'debug' : 'info';
}

module.exports = { logger, setVerbosity };