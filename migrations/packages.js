const fetch = require('node-fetch');
const fs = require('fs');
const { graphql } = require("@octokit/graphql");
const { logger, setVerbosity } = require('../logger');
require('dotenv').config();


const SOURCE_TOKEN = process.env.SOURCE_TOKEN;
const TARGET_TOKEN = process.env.TARGET_TOKEN;


/**
 * Migrates packages from source organization to target organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {Object} auth - Authentication object containing PATs
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {boolean} verbose - Whether to enable verbose logging
 */
async function migratePackages(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun, verbose) {
  setVerbosity(verbose);
  logger.info(`Starting package migration process... (Dry Run: ${dryRun})`);

  if (!SOURCE_TOKEN || !TARGET_TOKEN) {
    logger.error('SOURCE_TOKEN or TARGET_TOKEN is not set in the environment variables');
    return;
  }

  try {
    if (!dryRun) {
      preparePackagesDirectory();
    }
    const packages = await fetchPackages(sourceOctokit, sourceOrg);
    await processPackages(sourceOctokit, targetOctokit, sourceOrg, targetOrg, packages, dryRun);
  } catch (error) {
    logger.error('Error migrating packages:', error.message);
  }
}


/**
 * Prepares the packages directory.
 */
function preparePackagesDirectory() {
  if (fs.existsSync('packages')) {
    fs.rmSync('packages', { recursive: true });
  }
  fs.mkdirSync('packages');
}

/**
 * Fetches all packages in the organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @returns {Array} Array of packages
 */
async function fetchPackages(sourceOctokit, sourceOrg) {
  const { data: packages } = await sourceOctokit.packages.listPackagesForOrganization({
    package_type: 'maven',
    org: sourceOrg
  });
  logger.info(`Found ${packages.length} packages in organization: ${sourceOrg}`);
  return packages;
}

/**
 * Processes all packages for migration.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {Object} auth - Authentication object containing PATs
 * @param {Array} packages - Array of packages to process
 * @param {boolean} dryRun - Whether to perform a dry run
 */
async function processPackages(sourceOctokit, targetOctokit, sourceOrg, targetOrg, packages, dryRun) {
  for (const pkg of packages) {
    logger.info(`Processing package: ${pkg.name}`);
    try {
      await processPackage(sourceOctokit, targetOctokit, sourceOrg, targetOrg, pkg, dryRun);
    } catch (error) {
      logger.error(`Error processing package ${pkg.name}:`, error.message);
    }
  }
}

/**
 * Processes a single package for migration.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {Object} auth - Authentication object containing PATs
 * @param {Object} pkg - Package object to process
 * @param {boolean} dryRun - Whether to perform a dry run
 */
async function processPackage(sourceOctokit, targetOctokit, sourceOrg, targetOrg, pkg, dryRun) {
  if (!await checkTargetRepository(targetOctokit, targetOrg, pkg.repository.name)) {
    return;
  }

  if (await checkPackageExistsInTarget(targetOctokit, targetOrg, pkg.name)) {
    return;
  }

  const versions = await fetchPackageVersions(sourceOctokit, sourceOrg, pkg.name);
  
  if (dryRun) {
    logger.info(`[Dry Run] Would migrate package: ${pkg.name} from ${sourceOrg} to ${targetOrg}`);
    logger.info(`[Dry Run] Versions to migrate: ${versions.map(v => v.name).join(', ')}`);
  } else {
    await migratePackageVersions(sourceOctokit, targetOctokit, sourceOrg, targetOrg, pkg, versions, dryRun);
  }
}

/**
 * Checks if the target repository exists.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {string} repoName - Repository name
 * @returns {boolean} Whether the repository exists
 */
async function checkTargetRepository(targetOctokit, targetOrg, repoName) {
  try {
    await targetOctokit.repos.get({
      owner: targetOrg,
      repo: repoName
    });
    return true;
  } catch (repoError) {
    logger.warn(`Repository ${repoName} not found in target organization. Skipping...`);
    return false;
  }
}

/**
 * Checks if the package already exists in the target organization.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {string} packageName - Package name
 * @returns {boolean} Whether the package exists
 */
async function checkPackageExistsInTarget(targetOctokit, targetOrg, packageName) {
  try {
    await targetOctokit.packages.getPackageForOrganization({
      package_type: 'maven',
      package_name: packageName,
      org: targetOrg
    });
    logger.info(`Package ${packageName} already exists in target organization. Skipping...`);
    return true;
  } catch (packageError) {
    return false;
  }
}

/**
 * Fetches all versions of a package.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} packageName - Package name
 * @returns {Array} Array of package versions
 */
async function fetchPackageVersions(sourceOctokit, sourceOrg, packageName) {
  const { data: versions } = await sourceOctokit.packages.getAllPackageVersionsForPackageOwnedByOrg({
    package_type: 'maven',
    package_name: packageName,
    org: sourceOrg
  });
  logger.info(`Found ${versions.length} versions of the package ${packageName}`);
  return versions;
}

/**
 * Migrates all versions of a package.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {Object} auth - Authentication object containing PATs
 * @param {Object} pkg - Package object
 * @param {Array} versions - Array of package versions
 */
async function migratePackageVersions(sourceOctokit, targetOctokit, sourceOrg, targetOrg, pkg, versions, dryRun) {
  for (const version of versions) {
    logger.info(`Migrating version: ${version.name}`);
    try {
      await migratePackageVersion(sourceOctokit, sourceOrg, targetOrg, pkg, version, dryRun);
    } catch (versionError) {
      logger.error(`Error migrating version ${version.name} of ${pkg.name}:`, versionError.message);
    }
  }
}

/**
 * Migrates a single version of a package.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {Object} pkg - Package object
 * @param {Object} version - Version object
 * @param {boolean} dryRun - Whether to perform a dry run
 */
async function migratePackageVersion(sourceOctokit, sourceOrg, targetOrg, pkg, version, dryRun) {
  logger.info(`Migrating version ${version.name} of package ${pkg.name}`);

  try {
    const packageContent = await getPackageContent(sourceOctokit, sourceOrg, pkg.name, version.name);
    logger.debug('Package content retrieved successfully');

    const { downloadPackageUrl, uploadPackageUrl } = getPackageUrls(packageContent, sourceOrg, targetOrg, version.name);

    const filesToDownload = await listPackageAssets('maven', pkg.name, sourceOrg, version.name);
    logger.debug(`Files to download: ${filesToDownload.join(', ')}`);

    if (dryRun) {
      logger.info(`[Dry Run] Would download ${filesToDownload.length} files for ${pkg.name} version ${version.name}`);
      logger.info(`[Dry Run] Would upload ${filesToDownload.length} files to ${uploadPackageUrl}`);
    } else {
      for (const file of filesToDownload) {
        const fileUrl = `${downloadPackageUrl}/${file}`; // This is the correct URL now
        logger.debug(`Downloading file from: ${fileUrl}`);
        await downloadPackageFiles(fileUrl, pkg.name, file); // Pass just the filename, not an array
      }
      await uploadPackageFiles(uploadPackageUrl, pkg.name, filesToDownload);
    }

    logger.info(`${dryRun ? '[Dry Run] Would migrate' : 'Migrated'} version ${version.name} of ${pkg.name}`);
  } catch (error) {
    logger.error(`Error migrating version ${version.name} of ${pkg.name}: ${error.message}`);
  }
}

/**
 * Gets package content.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} packageName - Package name
 * @param {string} versionName - Version name
 * @returns {Object} Package content
 */
async function getPackageContent(sourceOctokit, sourceOrg, packageName, versionName) {
  const { data: packageContent } = await sourceOctokit.packages.getPackageForOrganization({
    package_type: 'maven',
    package_name: packageName,
    org: sourceOrg,
    version: versionName
  });
  return packageContent;
}

/**
 * Downloads a package file.
 * @param {string} fileUrl - URL to download the file from
 * @param {string} packageName - Package name
 * @param {string} fileName - Name of the file to download
 */
async function downloadPackageFiles(fileUrl, packageName, fileName) {
  fs.mkdirSync(`packages/${packageName}`, { recursive: true });
  logger.debug(`Downloading ${fileUrl}`);
  await downloadFile(fileUrl, `packages/${packageName}/${fileName}`);
}

/**
 * Uploads package files.
 * @param {string} uploadPackageUrl - URL to upload package files to
 * @param {string} packageName - Package name
 * @param {Array} filesToUpload - Array of files to upload
 */
async function uploadPackageFiles(uploadPackageUrl, packageName, filesToUpload) {
  for (const file of filesToUpload) {
    try {
      const fileContent = fs.readFileSync(`packages/${packageName}/${file}`);
      const headers = getUploadHeaders(file, fileContent);
      
      logger.debug(`Uploading to ${uploadPackageUrl}/${file}`);
      const response = await fetch(`${uploadPackageUrl}/${file}`, {
        method: 'PUT',
        headers: headers,
        body: fileContent
      });

      if (!response.ok) {
        logger.warn(`Failed to upload file ${file}, status: ${response.status}, message: ${response.statusText}`);
      } else {
        logger.debug(`Successfully uploaded ${file}`);
      }
    } catch (uploadError) {
      logger.error(`Error uploading file ${file}:`, uploadError.message);
    }
  }
}

/**
 * Gets headers for file upload.
 * @param {string} file - File name
 * @param {Buffer} fileContent - File content
 * @returns {Object} Headers object
 */
function getUploadHeaders(file, fileContent) {
  const headers = {
    Authorization: `token ${TARGET_TOKEN}`,
    'Content-Length': fileContent.length
  };

  if (file.endsWith('.pom')) {
    headers['Content-Type'] = 'application/xml';
  } else if (file.endsWith('.jar')) {
    headers['Content-Type'] = 'application/java-archive';
  } else {
    headers['Content-Type'] = 'application/octet-stream';
  }

  return headers;
}

/**
 * Downloads a file.
 * @param {string} url - URL to download from
 * @param {string} path - Path to save the file
 * @returns {boolean} Whether the download was successful
 */
async function downloadFile(url, path) {
  console.log(url)
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${SOURCE_TOKEN}`
    }
  });
  if (!response.ok) {
    logger.warn(`Failed to download file ${path}, status: ${response.status}, message: ${response.statusText}`);
    return false;
  }
  const buffer = await response.buffer();
  fs.writeFileSync(path, buffer);
  return true;
}

/**
 * Constructs package URLs.
 * @param {Object} packageContent - Package content object
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {string} versionName - Version name
 * @returns {Object} Object containing package URLs
 */
function getPackageUrls(packageContent, sourceOrg, targetOrg, versionName) {
  logger.debug('Package content:', JSON.stringify(packageContent, null, 2));

  const groupId = packageContent.name.split('.').slice(0, -1).join('.');
  const artifactId = packageContent.name.split('.').pop();
  const version = versionName;
  const repository = packageContent.repository.name;

  logger.debug(`Group ID: ${groupId}`);
  logger.debug(`Artifact ID: ${artifactId}`);
  logger.debug(`Version: ${version}`);
  logger.debug(`Repository: ${repository}`);

  const downloadBaseUrl = `https://maven.pkg.github.com/${sourceOrg}/${repository}`;
  const uploadBaseUrl = `https://maven.pkg.github.com/${targetOrg}/${repository}`;
  const downloadPackageUrl = `${downloadBaseUrl}/${groupId}/${artifactId}/${version}`;
  const uploadPackageUrl = `${uploadBaseUrl}/${groupId}/${artifactId}/${version}`;

  logger.debug(`Download Base URL: ${downloadBaseUrl}`);
  logger.debug(`Upload Base URL: ${uploadBaseUrl}`);
  logger.debug(`Download Package URL: ${downloadPackageUrl}`);
  logger.debug(`Upload Package URL: ${uploadPackageUrl}`);

  return { groupId, artifactId, repository, downloadBaseUrl, uploadBaseUrl, downloadPackageUrl, uploadPackageUrl };
}

/**
 * Lists package assets.
 * @param {string} package_type - Package type
 * @param {string} package_name - Package name
 * @param {string} org - Organization name
 * @param {string} package_version - Package version
 * @returns {Array} Array of asset names
 */
async function listPackageAssets(package_type, package_name, org, package_version) {
  const query = `
    query listPackageAssets($org: String!, $packageName: String!, $version: String!) {
      organization(login: $org) {
        packages(first: 1, names: [$packageName]) {
          nodes {
            version(version: $version) {
              files(first: 100) {
                nodes {
                  name
                }
              }
            }
          }
        }
      }
    }`;

  const variables = {
    org: org,
    packageName: package_name,
    version: package_version
  };

  try {
    logger.debug(`Fetching assets for package ${package_name} version ${package_version} in org ${org}`);
    
    const graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${SOURCE_TOKEN}`,
      },
    });

    const result = await graphqlWithAuth(query, variables);

    if (!result.organization || !result.organization.packages.nodes.length) {
      logger.warn(`No package found for ${package_name} in org ${org}`);
      return [];
    }

    const packageVersion = result.organization.packages.nodes[0].version;
    if (!packageVersion) {
      logger.warn(`Version ${package_version} not found for package ${package_name} in org ${org}`);
      return [];
    }

    const assets = packageVersion.files.nodes.map(node => node.name);
    logger.info(`Found ${assets.length} assets for package ${package_name} version ${package_version}`);
    return assets;
  } catch (error) {
    logger.error(`Error listing package assets for ${package_name} version ${package_version}:`, error.message);
    if (error.errors) {
      error.errors.forEach(e => logger.error(`GraphQL Error: ${e.message}`));
    }
    // Log the variables for debugging
    logger.error('Variables passed to GraphQL query:', JSON.stringify(variables, null, 2));
    return [];
  }
}

module.exports = { migratePackages };
