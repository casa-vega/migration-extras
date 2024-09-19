/**
 * cli.js - Command Line Interface for GitHub Organization Migration
 * 
 * This script provides a CLI for migrating various components between GitHub organizations.
 * It includes commands for migrating variables, teams, secrets, packages, and LFS objects.
 * 
 * Usage:
 *   node cli.js migrate <component> [options]
 * 
 * Components:
 *   - variables
 *   - teams
 *   - secrets
 *   - packages
 *   - lfs
 * 
 * Options:
 *   --source-org     Source GitHub organization
 *   --target-org     Target GitHub organization
 *   --dry-run        Perform a dry run without making changes (default: true)
 *   --verbose        Enable verbose output (default: false)
 * 
 * Environment Variables:
 *   SOURCE_ORG: Source GitHub organization (can be overridden by --source-org)
 *   TARGET_ORG: Target GitHub organization (can be overridden by --target-org)
 *   SOURCE_TOKEN: GitHub token for the source organization
 *   TARGET_TOKEN: GitHub token for the target organization
 */

const yargs = require("yargs");
const dotenv = require("dotenv");

// Load environment variables from .env file
dotenv.config();

// Import migration functions
const { migrateTeams } = require('./migrations/teams');
const { migrateVariables } = require('./migrations/variables');
const { migrateLFSObjects } = require('./migrations/objects');
const { migrateSecrets } = require('./migrations/secrets');
const { migratePackages } = require('./migrations/packages');

/**
 * Run a migration function with the provided parameters
 * @param {Object} argv - Command line arguments
 * @param {Function} migrationFunction - The migration function to run
 * @param {string} component - The component being migrated
 * @throws {Error} If required parameters are missing or if the migration fails
 */
async function runMigration(argv, migrationFunction, component) {
  const { 
    "source-org": sourceCLI, 
    "target-org": targetCLI, 
    "dry-run": dryRun,
    verbose
  } = argv;
  
  const sourceOrgToUse = process.env.SOURCE_ORG || sourceCLI;
  const targetOrgToUse = process.env.TARGET_ORG || targetCLI;
  const sourceToken = process.env.SOURCE_TOKEN;
  const targetToken = process.env.TARGET_TOKEN;

  if (!sourceOrgToUse || !targetOrgToUse || !sourceToken || !targetToken) {
    throw new Error(
      "SOURCE_ORG, TARGET_ORG, SOURCE_TOKEN, and TARGET_TOKEN must be set in the .env file or provided as command line options"
    );
  }

  // Dynamically import Octokit as it's now an ES module
  const { Octokit } = await import('@octokit/rest');

  // Create Octokit instances for source and target orgs
  const sourceOctokit = new Octokit({ 
    auth: sourceToken,
    throttle: {
      onRateLimit: (retryAfter, options) => {
        if (verbose) console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
        if (options.request.retryCount === 0) { // only retries once
          console.log(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onAbuseLimit: (retryAfter, options) => {
        if (verbose) console.warn(`Abuse detected for request ${options.method} ${options.url}`);
      }
    }
  });
  const targetOctokit = new Octokit({ 
    auth: targetToken,
    throttle: {
      onRateLimit: (retryAfter, options) => {
        if (verbose) console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
        if (options.request.retryCount === 0) { // only retries once
          console.log(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onAbuseLimit: (retryAfter, options) => {
        if (verbose) console.warn(`Abuse detected for request ${options.method} ${options.url}`);
      }
    }
  });

  if (verbose) {
    console.log(`Starting migration of ${component} from ${sourceOrgToUse} to ${targetOrgToUse}`);
    console.log(`Dry run: ${dryRun ? "Yes" : "No"}`);
  }

  try {
    await migrationFunction(
      sourceOctokit,
      targetOctokit,
      sourceOrgToUse,
      targetOrgToUse,
      dryRun,
      verbose
    );

    if (verbose) {
      console.log(`Migration of ${component} completed successfully`);
    }
  } catch (error) {
    console.error(`Migration of ${component} failed: ${error.message}`);
    if (verbose) {
      console.error(error.stack);
    }
    throw error; // Re-throw the error for the main handler to catch
  }
}

// functions map
const migrationFunctions = {
  variables: migrateVariables,
  teams: migrateTeams,
  secrets: migrateSecrets,
  packages: migratePackages,
  lfs: migrateLFSObjects,
};

// CLI commands
yargs
  .command({
    command: "migrate <component>",
    describe: "Migrate data from source org to target org",
    builder: (yargs) => {
      return yargs
        .positional("component", {
          describe: "Component to migrate",
          choices: Object.keys(migrationFunctions),
        })
        .option("source-org", {
          type: "string",
          describe: "Source GitHub organization",
        })
        .option("target-org", {
          type: "string",
          describe: "Target GitHub organization",
        })
        .option("dry-run", {
          type: "boolean",
          describe: "Perform a dry run",
          default: true,
        })
        .option("verbose", {
          type: "boolean",
          describe: "Enable verbose output",
          default: false,
        })
        .help();
    },
    handler: async (argv) => {
      const migrationFunction = migrationFunctions[argv.component];
      if (!migrationFunction) {
        console.error(`Unknown component: ${argv.component}`);
        process.exit(1);
      }
    
      try {
        await runMigration(argv, migrationFunction, argv.component);
      } catch (error) {
        console.error(`Migration of ${argv.component} failed. See above for error details.`);
        process.exit(1);
      }
    },
  })
  .demandCommand(1, "You need to specify a command to run")
  .help()
  .argv;
