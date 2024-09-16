const yargs = require('yargs');
const dotenv = require('dotenv');
const { Octokit } = require('@octokit/rest');

// Load environment variables from .env file
dotenv.config();

// Check for SOURCE_ORG and TARGET_ORG environment variables
const sourceOrg = process.env.SOURCE_ORG;
const targetOrg = process.env.TARGET_ORG

// Import migration functions
const { migrateTeams } = require('./teams');
const { migrateVariables } = require('./variables');
const { migrateLFSObjects } = require('./objects');
const { migrateSecrets }= require('./secrets');
const migratePackages = require('./packages');


// Define the CLI commands
yargs.command({
  command: 'migrate',
  describe: 'Migrate data from source org to target org',
  builder: (yargs) => {
    yargs.option('sourceOrg', {
      type: 'string',
      describe: 'Source GitHub organization',
    });
    yargs.option('targetOrg', {
      type: 'string',
      describe: 'Target GitHub organization',
    });
    yargs.option('dryRun', {
      type: 'boolean',
      describe: 'Perform a dry run without making any changes',
      default: true,
    });

    yargs.command({
      command: 'variables',
      describe: 'Migrate variables',
      handler: async (argv) => {
        await runMigration(argv, migrateVariables);
      },
    });

    yargs.command({
      command: 'teams',
      describe: 'Migrate teams',
      handler: async (argv) => {
        await runMigration(argv, migrateTeams);
      },
    });

    yargs.command({
      command: 'secrets',
      describe: 'Migrate secrets',
      handler: async (argv) => {
        await runMigration(argv, migrateSecrets);
      },
    });

    yargs.command({
      command: 'packages',
      describe: 'Migrate packages',
      handler: async (argv) => {
        await runMigration(argv, migratePackages);
      },
    });

    yargs.command({
      command: 'lfsObjects',
      describe: 'Migrate LFS objects',
      handler: async (argv) => {
        await runMigration(argv, migrateLFSObjects);
      },
    });
  },
});

// Run the CLI
yargs.parse();

// Helper function to run a migration
async function runMigration(argv, migrationFunction) {
  const sourceOrgToUse = process.env.SOURCE_ORG || argv['source-org'];
  const targetOrgToUse = process.env.TARGET_ORG || argv['target-org'];
  const dryRun = argv['dry-run'];

  if (!sourceOrgToUse || !targetOrgToUse) {
    console.error('Error: SOURCE_ORG and TARGET_ORG must be set in the .env file or provided as command line options (--source-org and --target-org)');
    process.exit(1);
  }

  // Create Octokit instances for source and target orgs
  const sourceOctokit = new Octokit({
    auth: process.env.SOURCE_ORG_PAT,
  });

  const targetOctokit = new Octokit({
    auth: process.env.TARGET_ORG_PAT,
  });

  // Pass the sourceOrgToUse and targetOrgToUse variables to the migrationFunction
  await migrationFunction(sourceOctokit, targetOctokit, sourceOrgToUse, targetOrgToUse, dryRun);
}