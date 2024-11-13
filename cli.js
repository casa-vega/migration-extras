import fs from 'fs/promises';
import path from 'path';

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import dotenv from "dotenv";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { graphql } from '@octokit/graphql';
import { ProxyAgent, fetch as undiciFetch } from "undici";

import {migrateTeams} from './migrations/teams.js';
import {migrateVariables} from './migrations/variables.js';
import {migrateLFSObjects} from './migrations/objects.js';
import {migratePackages} from './migrations/packages.js';

dotenv.config();

const myFetch = (url, opts) => {
  return undiciFetch(url, {
    ...opts,
    ...(process.env.HTTPS_PROXY && {
      dispatcher: new ProxyAgent({
        uri: process.env.HTTPS_PROXY,
        keepAliveTimeout: 10,
        keepAliveMaxTimeout: 10,
      }),
    }),
  });
};

async function readPrivateKey(keyPath) {
  try {
    const absolutePath = path.resolve(process.cwd(), keyPath);
    console.log('Reading private key from:', absolutePath);
    const key = await fs.readFile(absolutePath, 'utf8');
    return key.trim();
  } catch (error) {
    throw new Error(`Failed to read private key from ${keyPath}: ${error.message}`);
  }
}

async function createSourceOctokitInstance(token, verbose) {
  if (!token) {
    throw new Error('Source token is required for source Octokit instance');
  }

  return new Octokit({
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
}

async function createTargetOctokitInstance(verbose) {
  try {
    const privateKey = await readPrivateKey(process.env.TARGET_PRIVATE_KEY_PATH);
    
    return new Octokit({
      request: { fetch: myFetch },
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.TARGET_APP_ID,
        privateKey,
        installationId: process.env.TARGET_INSTALLATION_ID,
      },
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
  } catch (error) {
    console.error('Failed to create target Octokit instance:', error);
    throw error;
  }
}

async function createGraphQLInstance(type, token, verbose) {
  try {
    if (type === 'source' && token) {
      return graphql.defaults({
        headers: {
          authorization: `token ${token}`,
        },
        request: { fetch: myFetch },
      });
    }

    const privateKey = await readPrivateKey(process.env.TARGET_PRIVATE_KEY_PATH);
    
    const auth = createAppAuth({
      appId: process.env.TARGET_APP_ID,
      privateKey,
      installationId: process.env.TARGET_INSTALLATION_ID,
    });

    const installationAuthentication = await auth({
      type: "installation",
    });
    
    return graphql.defaults({
      headers: {
        authorization: `token ${installationAuthentication.token}`,
      },
      request: { fetch: myFetch },
    });
  } catch (error) {
    console.error(`Failed to create GraphQL instance for ${type}:`, error);
    throw error;
  }
}

async function testConnection(octokit, type, org) {
  try {
    if (type === 'source' && process.env.SOURCE_TOKEN) {
      // For PAT auth, we can use the users endpoint
      const userResponse = await octokit.rest.users.getAuthenticated();
      console.log(`Source connection successful: ${userResponse.data.login}`);
    } else {
      // For GitHub Apps, test by getting org info instead
      const orgResponse = await octokit.rest.orgs.get({
        org: org
      });
      console.log(`${type} connection successful for org: ${orgResponse.data.login}`);
    }
  } catch (error) {
    console.error(`${type} connection test failed:`, error);
    throw error;
  }
}

async function runMigration(argv, migrationFunction, component) {
  try {
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

    // Validate required environment variables
    const requiredVars = {
      'SOURCE_ORG': sourceOrgToUse,
      'TARGET_ORG': targetOrgToUse,
      'TARGET_APP_ID': process.env.TARGET_APP_ID,
      'TARGET_INSTALLATION_ID': process.env.TARGET_INSTALLATION_ID,
      'TARGET_PRIVATE_KEY_PATH': process.env.TARGET_PRIVATE_KEY_PATH
    };

    const missingVars = Object.entries(requiredVars)
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missingVars.length > 0) {
      throw new Error(`Missing required variables: ${missingVars.join(', ')}`);
    }

    console.log('Migration configuration:', {
      sourceOrg: sourceOrgToUse,
      targetOrg: targetOrgToUse,
      component,
      packageType,
      dryRun,
      verbose,
      hasSourceToken: Boolean(sourceToken),
      hasPrivateKeyPath: Boolean(process.env.TARGET_PRIVATE_KEY_PATH),
      targetAppId: process.env.TARGET_APP_ID,
      targetInstallationId: process.env.TARGET_INSTALLATION_ID
    });

    // Create instances
    console.log('Creating Octokit and GraphQL instances...');
    
    const targetOctokit = await createTargetOctokitInstance(verbose);
    const sourceOctokit = sourceToken ? 
      await createSourceOctokitInstance(sourceToken, verbose) : 
      targetOctokit;
      
    const targetGraphQL = await createGraphQLInstance('target', null, verbose);
    const sourceGraphQL = sourceToken ?
      await createGraphQLInstance('source', sourceToken, verbose) :
      targetGraphQL;

    // Test connections
    console.log('Testing connections...');
    await testConnection(sourceOctokit, 'source', sourceOrgToUse);
    await testConnection(targetOctokit, 'target', targetOrgToUse);

    // Execute migration
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

    console.log(`Migration of ${component} completed successfully`);
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

// Migration functions map
const migrationFunctions = {
  variables: migrateVariables,
  teams: migrateTeams,
  packages: migratePackages,
  lfs: migrateLFSObjects,
};

// CLI configuration
yargs(hideBin(process.argv))
  .command({
    command: "migrate <component>",
    describe: "Migrate data from source org to target org",
    builder: (yargs) => {
      return yargs
        .positional("component", {
          describe: "Component to migrate",
          choices: Object.keys(migrationFunctions),
          type: "string",
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
          describe: "Perform a dry run without making changes",
          default: true,
        })
        .option("package-type", {
          type: "string",
          describe: "Package type for package migration",
          choices: ["npm", "container", "maven", "nuget", "rubygems"],
        })
        .option("verbose", {
          type: "boolean",
          describe: "Enable verbose logging",
          default: false,
        });
    },
    handler: async (argv) => {
      try {
        const migrationFunction = migrationFunctions[argv.component];
        if (!migrationFunction) {
          console.error(`Unknown component: ${argv.component}`);
          process.exit(1);
        }
    
        console.log('Starting migration process...');
        await runMigration(argv, migrationFunction, argv.component);
        console.log('Migration completed successfully');
        process.exit(0);
      } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
      }
    },
  })
  .demandCommand(1, "You need to specify a command to run")
  .strict()
  .help()
  .argv;

// Add global error handlers
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
