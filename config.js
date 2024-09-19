/**
 * config.js
 * 
 * This file contains configuration settings for the GitHub Migration Extras CLI (unofficial).
 * These settings are not environment-specific and can be version controlled.
 */

module.exports = {
    // Maximum number of retries for rate-limited API calls
    maxRetries: 3,
  
    // Delay (in milliseconds) between retries
    retryDelay: 5000,
  
    // Timeout (in milliseconds) for API calls
    apiTimeout: 30000,
  
    // Maximum number of concurrent API requests
    maxConcurrency: 5,
  
    // Log file path
    logFilePath: './logs/migration.log',
  
    // Log level (error, warn, info, verbose, debug, silly)
    logLevel: 'info',
  
    // Components available for migration
    availableComponents: ['variables', 'teams', 'secrets', 'packages', 'lfs'],
  
    // Default values for CLI options
    defaults: {
      dryRun: true,
      verbose: false
    }
  };
