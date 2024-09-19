const { logger, setVerbosity } = require('./logger');

/**
 * Migrates variables from source organization to target organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {boolean} verbose - Whether to enable verbose logging
 */
async function migrateVariables(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun, verbose) {
  setVerbosity(verbose);
  
  const variableMigrations = {
    variables: [],
    errors: [],
  };

  try {
    await Promise.all([
      migrateRepoVariables(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun, variableMigrations),
      migrateOrgVariables(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun, variableMigrations)
    ]);
  } catch (error) {
    logger.error(`Failed to migrate variables: ${error.message}`);
    variableMigrations.errors.push({ message: error.message });
  }

  logger.info('Variable migration completed');
  console.log(JSON.stringify(variableMigrations, null, 2));
}

/**
 * Migrates repository variables.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {Object} variableMigrations - Object to store migration results
 */
async function migrateRepoVariables(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun, variableMigrations) {
  const sourceRepos = await sourceOctokit.paginate(sourceOctokit.repos.listForOrg, {
    org: sourceOrg,
    per_page: 100,
  });

  await Promise.all(sourceRepos.map(repo => 
    migrateVariablesForRepo(sourceOctokit, targetOctokit, sourceOrg, targetOrg, repo.name, dryRun, variableMigrations)
  ));
}

/**
 * Migrates variables for a single repository.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {string} repoName - Repository name
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {Object} variableMigrations - Object to store migration results
 */
async function migrateVariablesForRepo(sourceOctokit, targetOctokit, sourceOrg, targetOrg, repoName, dryRun, variableMigrations) {
  try {
    const variables = await sourceOctokit.paginate(sourceOctokit.actions.listRepoVariables, {
      owner: sourceOrg,
      repo: repoName,
      per_page: 100,
    });

    await Promise.all(variables.map(variable => 
      migrateVariable(targetOctokit, targetOrg, repoName, variable, dryRun, variableMigrations)
    ));
  } catch (error) {
    logger.error(`Failed to migrate variables for repo ${repoName}: ${error.message}`);
    variableMigrations.errors.push({ repo: repoName, message: error.message });
  }
}

/**
 * Migrates a single variable.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {string} repoName - Repository name
 * @param {Object} variable - Variable to migrate
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {Object} variableMigrations - Object to store migration results
 */
async function migrateVariable(targetOctokit, targetOrg, repoName, variable, dryRun, variableMigrations) {
  if (!dryRun) {
    try {
      await targetOctokit.actions.createRepoVariable({
        owner: targetOrg,
        repo: repoName,
        name: variable.name,
        value: variable.value,
      });
      logger.debug(`Migrated variable ${variable.name} for repo ${repoName}`);
    } catch (error) {
      logger.error(`Failed to migrate variable ${variable.name} for repo ${repoName}: ${error.message}`);
      variableMigrations.errors.push({ repo: repoName, name: variable.name, message: error.message });
      return;
    }
  }
  variableMigrations.variables.push({ repo: repoName, name: variable.name, value: variable.value });
}

/**
 * Migrates organization variables.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {Object} variableMigrations - Object to store migration results
 */
async function migrateOrgVariables(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun, variableMigrations) {
  try {
    const orgVariables = await sourceOctokit.paginate(sourceOctokit.actions.listOrgVariables, {
      org: sourceOrg,
      per_page: 100,
    });

    await Promise.all(orgVariables.map(variable => 
      migrateOrgVariable(targetOctokit, targetOrg, variable, dryRun, variableMigrations)
    ));
  } catch (error) {
    logger.error(`Failed to migrate organization variables: ${error.message}`);
    variableMigrations.errors.push({ message: error.message });
  }
}

/**
 * Migrates a single organization variable.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {Object} variable - Variable to migrate
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {Object} variableMigrations - Object to store migration results
 */
async function migrateOrgVariable(targetOctokit, targetOrg, variable, dryRun, variableMigrations) {
  if (!dryRun) {
    try {
      await targetOctokit.actions.createOrgVariable({
        org: targetOrg,
        name: variable.name,
        value: variable.value,
        visibility: variable.visibility,
        selected_repository_ids: variable.selected_repository_ids,
      });
      logger.debug(`Migrated organization variable ${variable.name}`);
    } catch (error) {
      logger.error(`Failed to migrate organization variable ${variable.name}: ${error.message}`);
      variableMigrations.errors.push({ org: targetOrg, name: variable.name, message: error.message });
      return;
    }
  }
  variableMigrations.variables.push({ org: targetOrg, name: variable.name, value: variable.value });
}

module.exports = { migrateVariables };