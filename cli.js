
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import { graphql } from '@octokit/graphql';
import { ProxyAgent, fetch as undiciFetch } from "undici";

import {migrateTeams} from './migrations/teams.js';
import {migrateVariables} from './migrations/variables.js';
import {migrateLFSObjects} from './migrations/objects.js';
import {migrateSecrets} from './migrations/secrets.js';
import {migratePackages} from './migrations/packages.js';

dotenv.config();

/**
 * Creates an Octokit instance with provided authentication token and logging options.
 * @param {string} token - The authentication token for the Octokit instance.
 * @param {boolean} verbose - Enable verbose logging for rate limits and abuse limits.
 * @returns {Octokit} - A configured Octokit instance.
 */
async function createOctokitInstance(token, verbose) {

  const myFetch = (url, opts) => {
    return undiciFetch(url, {
      ...opts,
      dispatcher: new ProxyAgent({
        uri: process.env.HTTPS_PROXY,
        keepAliveTimeout: 10,
        keepAliveMaxTimeout: 10,
      }),
    });
  };

  const octokit = new Octokit({
    request: { fetch: myFetch },
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options) => {
        if (verbose) {
          console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
        }
        if (options.request.retryCount === 0) {
          console.log(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onAbuseLimit: (retryAfter, options) => {
        if (verbose) {
          console.warn(`Abuse detected for request ${options.method} ${options.url}`);
        }
      },
    },
  });
  console.info(octokit.token)
  return octokit;
}

async function createGraphQLInstance(token, verbose) {
  const myFetch = (url, opts) => {
    return undiciFetch(url, {
      ...opts,
      dispatcher: new ProxyAgent({
        uri: process.env.HTTPS_PROXY,
        keepAliveTimeout: 10,
        keepAliveMaxTimeout: 10,
      }),
    });
  };

  return graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
    request: { fetch: myFetch },
    throttle: {
      onRateLimit: (retryAfter, options) => {
        if (verbose) {
          console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
        }
        if (options.request.retryCount === 0) {
          console.log(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onAbuseLimit: (retryAfter, options) => {
        if (verbose) {
          console.warn(`Abuse detected for request ${options.method} ${options.url}`);
        }
      },
    },
  });
}

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
    "package-type": packageType,
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

  // Use helper function to create Octokit instances
  console.log('Creating Octokit instances...');
  const sourceOctokit = await createOctokitInstance(sourceToken, verbose);
  const targetOctokit = await createOctokitInstance(targetToken, verbose);
  const sourceGraphQL = await createGraphQLInstance(sourceToken, verbose);
  const targetGraphQL = await createGraphQLInstance(targetToken, verbose);

  if (verbose) {
    console.log(`Starting migration of ${component} from ${sourceOrgToUse} to ${targetOrgToUse}`);
    console.log(`Dry run: ${dryRun ? "Yes" : "No"}`);
  }

  try {
    await migrationFunction(
      sourceOctokit,
      targetOctokit,
      sourceGraphQL,
      targetGraphQL,
      sourceOrgToUse,
      targetOrgToUse,
      packageType,
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
    throw error;
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
yargs(hideBin(process.argv))
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
        console.log(`Starting migration of ${argv.component}...`);
        await runMigration(argv, migrationFunction, argv.component);
        console.log(`Migration of ${argv.component} completed successfully.`);
      } catch (error) {
        console.error(`Migration of ${argv.component} failed. Error details:`);
        console.error(error);
        if (error.stack) {
          console.error('Stack trace:');
          console.error(error.stack);
        }
        process.exit(1);
      }
    },
  })
  .demandCommand(1, "You need to specify a command to run")
  .help()
  .argv;

