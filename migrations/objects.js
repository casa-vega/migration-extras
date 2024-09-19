const { mkdtempSync, rmSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");
const { execSync } = require("child_process");
const { logger, setVerbosity } = require("../logger");

/**
 * Migrates LFS objects from source organization to target organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {boolean} verbose - Whether to enable verbose logging
 */
async function migrateLFSObjects(
  sourceOctokit,
  targetOctokit,
  sourceOrg,
  targetOrg,
  dryRun,
  verbose
) {
  setVerbosity(verbose);
  logger.info(
    `Starting LFS objects migration from ${sourceOrg} to ${targetOrg}`
  );
  logger.info(`Dry run: ${dryRun}`);

  const result = {
    repositories: [],
    errors: [],
  };

  try {
    const repos = await fetchRepositories(sourceOctokit, sourceOrg);
    await checkLFSUsageForRepos(sourceOctokit, sourceOrg, repos, result);

    if (!dryRun) {
      const lfsRepos = result.repositories
        .filter((repo) => repo.usesLFS)
        .map((repo) => repo.name);
      await migrateLFS(sourceOrg, targetOrg, lfsRepos);
    }

    logger.info("LFS objects migration completed");
    logger.info(JSON.stringify(result, null, 2));
  } catch (error) {
    logger.error("Error during LFS objects migration:", error.message);
    result.errors.push({ message: error.message });
  }
}

/**
 * Fetches repositories from the source organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @returns {Array} Array of repositories
 */
async function fetchRepositories(sourceOctokit, sourceOrg) {
  logger.info(`Fetching repositories from ${sourceOrg}`);
  const repos = await sourceOctokit.paginate(sourceOctokit.repos.listForOrg, {
    org: sourceOrg,
    per_page: 100,
  });
  logger.info(`Found ${repos.length} repositories in ${sourceOrg}`);
  return repos;
}

/**
 * Checks LFS usage for all repositories.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @param {Array} repos - Array of repositories
 * @param {Object} result - Result object to store findings
 */
async function checkLFSUsageForRepos(sourceOctokit, sourceOrg, repos, result) {
  logger.info(`Checking all repositories in ${sourceOrg} for LFS usage...`);
  for (const repo of repos) {
    try {
      const usesLFS = await checkLFSUsage(sourceOctokit, sourceOrg, repo.name);
      result.repositories.push({
        name: repo.name,
        usesLFS,
      });
      logger.debug(`Repository ${repo.name} uses LFS: ${usesLFS}`);
    } catch (error) {
      logger.error(`Error checking LFS usage for ${repo.name}:`, error.message);
      result.errors.push({ repo: repo.name, message: error.message });
    }
  }
}

/**
 * Checks if a repository uses LFS.
 * @param {Object} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {boolean} Whether the repository uses LFS
 */
async function checkLFSUsage(octokit, owner, repo) {
  const maxDepth = parseInt(process.env.MAX_DEPTH) || 1;
  async function searchDirectory(path = "", depth = 0) {
    if (depth >= maxDepth) {
      return false;
    }
    const maxAttempts = 10;
    const timeout = 10000;
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        const startTime = Date.now();
        const { data } = await octokit.repos.getContent({ owner, repo, path });
        const endTime = Date.now();
        if (endTime - startTime > timeout) {
          attempts++;
          continue;
        }
        for (const item of data) {
          if (item.type === "file" && item.name === ".gitattributes") {
            const { data: fileContent } = await octokit.repos.getContent({
              owner,
              repo,
              path: item.path,
              mediaType: { format: "raw" },
            });
            if (fileContent.includes("filter=lfs")) {
              return true;
            }
          } else if (item.type === "dir") {
            const hasLFS = await searchDirectory(item.path, depth + 1);
            if (hasLFS) {
              return true;
            }
          }
        }
        return false;
      } catch (error) {
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000)); // wait 1 second before retrying
        } else {
          logger.warn(`Max attempts reached for ${repo} at path ${path}`);
          return false;
        }
      }
    }
  }
  return searchDirectory();
}

/**
 * Migrates LFS objects for repositories.
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {Array} lfsRepos - Array of repository names that use LFS
 */
async function migrateLFS(sourceOrg, targetOrg, lfsRepos, dryRun) {
  logger.info(
    `Migrating LFS objects from source organization: ${sourceOrg} to target organization: ${targetOrg}`
  );

  for (const repo of lfsRepos) {
    const repoName = repo.name || repo; // Ensure repoName is correctly extracted
    logger.info(`Migrating LFS objects for repository: ${repoName}`);

    if (dryRun) {
      logger.info(`[Dry Run] Would migrate LFS objects for repository: ${repoName}`);
      continue; // Skip the actual migration during dry run
    }

    try {
      const tempDir = mkdtempSync(join(tmpdir(), `repo-migration-${repoName}`));
      try {
        await cloneRepository(sourceOrg, repoName, tempDir);
        await updateRemoteUrl(targetOrg, repoName, tempDir);
        await migrateLFSPushGit(targetOrg, repoName, tempDir);
      } finally {
        rmSync(tempDir, { recursive: true });
      }
    } catch (error) {
      logger.error(
        `Error migrating LFS objects for repository ${repoName}:`,
        error.message
      );
    }
  }
}

/**
 * Clones a repository.
 * @param {string} sourceOrg - Source organization name
 * @param {string} repoName - Repository name
 * @param {string} tempDir - Temporary directory path
 */
async function cloneRepository(sourceOrg, repoName, tempDir) {
  logger.info(`Cloning repository: ${repoName}`);
  execSync(
    `git clone https://x-access-token:${process.env.SOURCE_ORG_PAT}@github.com/${sourceOrg}/${repoName}.git ${tempDir}`
  );
}

/**
 * Updates the remote URL of a repository.
 * @param {string} targetOrg - Target organization name
 * @param {string} repoName - Repository name
 * @param {string} tempDir - Temporary directory path
 */
async function updateRemoteUrl(targetOrg, repoName, tempDir) {
  logger.info(`Updating remote URL for: ${repoName}`);
  execSync(
    `cd ${tempDir} && git remote set-url origin https://github.com/${targetOrg}/${repoName}.git`
  );
}

/**
 * Migrates LFS objects for a repository.
 * @param {string} targetOrg - Target organization name
 * @param {string} repoName - Repository name
 * @param {string} tempDir - Temporary directory path
 */
async function migrateLFSPushGit(targetOrg, repoName, tempDir) {
  logger.info(
    `Updating Git config to use target PAT for LFS push for repository: ${repoName}`
  );
  execSync(
    `cd ${tempDir} && git config --add lfs.https://github.com/${targetOrg}/${repoName}.git.basic true && git config --add lfs.https://github.com/${targetOrg}/${repoName}.git.username github-actions && git config --add lfs.https://github.com/${targetOrg}/${repoName}.git.password ${process.env.TARGET_TOKEN}`
  );

  logger.info(`Migrating LFS objects for repository: ${repoName}`);
  execSync(`cd ${tempDir} && git lfs fetch --all && git lfs push --all origin`);

  logger.info(
    `Resetting Git config after LFS push for repository: ${repoName}`
  );
  execSync(
    `cd ${tempDir} && git config --unset-all lfs.https://github.com/${targetOrg}/${repoName}.git.basic && git config --unset-all lfs.https://github.com/${targetOrg}/${repoName}.git.username && git config --unset-all lfs.https://github.com/${targetOrg}/${repoName}.git.password`
  );
}

module.exports = { migrateLFSObjects };
