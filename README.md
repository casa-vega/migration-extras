# GitHub Migration Extras CLI

This CLI tool allows you to migrate various components (variables, teams, secrets, packages, LFS objects) between GitHub organizations. It provides options for performing migrations in dry-run mode, verbose logging, and includes robust error handling and logging.

## TODO

- add mapping file to team creation
- fix LFS auth in actions
- add npm, docker, ruby (same as gradle)
- add releases gh extension
- research environments

## In-flight
- post-migration action with caching, and environments for stepping through

## Features

- **Variables**: Migrate repository and organization-level variables.
- **Teams**: Migrate teams, their hierarchy, members, and repositories.
- **Secrets**: Migrate GitHub Actions secrets with encryption.
- **Packages**: Migrate Maven packages and their versions.
- **LFS Objects**: Migrate Git Large File Storage objects between repositories.
- **Dry Run**: Preview migrations without making changes.
- **Verbose Logging**: Enable detailed logs for debugging purposes.

## Requirements

- **Node.js** (v20+)
- **GitHub Personal Access Tokens** (PATs) for both the source and target organizations with the necessary scopes:
  - `repo`
  - `admin:org`
  - `workflow`
  - `packages`
  - `read:packages`
  - `write:packages`

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/github-org-migration-cli.git
   cd github-org-migration-cli
   ```

2. Install the necessary dependencies:
   ```bash
   npm i
   ```

3. Create a .env file in the project root and configure the following environment variables:
   ```bash
   # Source organization details
   SOURCE_ORG=<source_organization>
   SOURCE_TOKEN=<your_source_pat>
  
   # Target organization details
   TARGET_ORG=<target_organization>
   TARGET_TOKEN=<your_target_pat>
   ```

## Usage

Run the CLI using Node.js. Below is an example of how to run the migration for a specific component:

```
node cli.js migrate <component> [options]
```

### Components

The following components are supported for migration:

- variables: Migrate repository and organization-level variables.
- teams: Migrate teams, including members, hierarchy, and repositories.
- secrets: Migrate GitHub Actions secrets.
- packages: Migrate Maven packages and their versions.
- lfs: Migrate Git Large File Storage objects.

### Options

| Option         | Description                                                                 |
|----------------|-----------------------------------------------------------------------------|
| `--source-org` | Specify the source GitHub organization. Overrides `SOURCE_ORG` from `.env`. |
| `--target-org` | Specify the target GitHub organization. Overrides `TARGET_ORG` from `.env`. |
| `--dry-run`    | Perform a dry run without making changes (default: `true`).                 |
| `--verbose`    | Enable verbose logging output (default: `false`).                           |

### Example Commands

#### Migrate Variables (dry-run by default)
```
node cli.js migrate variables --source-org my-source-org --target-org my-target-org
```
#### Migrate Teams (really run)
```
node cli.js migrate teams --verbose --dry-run=false
```

## Logging
Logs for the migration are stored in the logs/migration.log file. The logger is powered by winston and can be customized through the config.js file.

You can adjust the log level and verbosity via CLI options or configuration settings in config.js:

```javascript
module.exports = {
  logLevel: 'info',  // Set the default log level ('error', 'warn', 'info', 'verbose', 'debug')
  maxRetries: 3,
  retryDelay: 5000,
  apiTimeout: 30000
};
```

## Environment Variables
In addition to the .env file, you can specify custom settings for GitHub tokens, organizations, and other migration options:
```bash
# Source and target organizations and tokens
SOURCE_ORG=my-source-org
TARGET_ORG=my-target-org
SOURCE_TOKEN=my-source-token
TARGET_TOKEN=my-target-token
```

## Components Overview

### Variables
Migrates both repository and organization-level variables from the source to the target organization. This includes retrieving variables using the GitHub Actions API and transferring them to the target organization.
- File: `variables.js`
- Command: `node cli.js migrate variables`

### Teams
Handles team migration, including hierarchy, members, and repository permissions. Teams are transferred from the source to the target organization while maintaining the original structure.
- File: `teams.js`
- Command: `node cli.js migrate teams`

### Secrets
Migrates GitHub Actions secrets from both the organization and repositories, using encryption to securely transfer secrets to the target organization.
- File: secrets.js
- Command: node cli.js migrate secrets

### Packages
Migrates Maven packages and their versions from the source organization to the target organization. This includes package assets and metadata.
- File: packages.js
- Command: `node cli.js migrate packages`

### LFS Objects
Migrates Git Large File Storage objects between repositories in the source and target organizations.
- File: `objects.js`
- Command: `node cli.js migrate lfs`

## Error Handling
If any errors occur during the migration process, they are logged in logs/migration.log. You can also enable verbose logging using the --verbose flag to view detailed error messages directly in the console.
