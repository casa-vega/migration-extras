const fs = require('fs');
const { logger, setVerbosity } = require('../logger');
const { exitOnError } = require('winston');
const { execSync } = require('child_process');
require('dotenv').config();

let fetch, graphql;
(async () => {
  fetch = (await import('node-fetch')).default;
  graphql = (await import('@octokit/graphql')).graphql;
})();

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
async function migratePackages(sourceOctokit, targetOctokit, sourceOrg, targetOrg, packageType, dryRun, verbose) {
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
    const packages = await fetchPackages(sourceOctokit, sourceOrg, packageType);
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
async function fetchPackages(sourceOctokit, sourceOrg, packageType) {
  const { data: packages } = await sourceOctokit.packages.listPackagesForOrganization({
    package_type: packageType,
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
    try {
      await processPackage(sourceOctokit, targetOctokit, sourceOrg, targetOrg, pkg, dryRun);
    } catch (error) {
      logger.error(`Error processing package ${pkg.name}:`, error);
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
  logger.info(`Processing package: ${pkg.name} (${pkg.package_type})`);
  if (!await checkTargetRepository(targetOctokit, targetOrg, pkg.repository.name)) {
    return;
  }

  if (await checkPackageExistsInTarget(targetOctokit, targetOrg, pkg.name)) {
    return;
  }

  const versions = await fetchPackageVersions(sourceOctokit, sourceOrg, pkg);
  
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
    logger.info(`Checking if repository ${repoName} exists in target organization...`);
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
async function checkPackageExistsInTarget(targetOctokit, targetOrg, packageName, packageType) {
  try {
    logger.info(`Checking if package ${packageName} exists in target organization...`);
    await targetOctokit.packages.getPackageForOrganization({
      package_type: packageType,
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
async function fetchPackageVersions(sourceOctokit, sourceOrg, pkg) {
  logger.info(`Fetching versions of package: ${pkg.name} (${pkg.package_type})`);
  const { data: versions } = await sourceOctokit.packages.getAllPackageVersionsForPackageOwnedByOrg({
    package_type: pkg.package_type,
    package_name: pkg.name,
    org: sourceOrg
  });
  logger.info(`Found ${versions.length} versions of the package ${pkg.name}`);
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
  for (const version of versions.reverse()) {
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
    const packageContent = await getPackageContent(sourceOctokit, sourceOrg, pkg, version.name);
    logger.debug('Package content retrieved successfully');

    const { downloadBaseUrl, downloadPackageUrl, uploadPackageUrl } = getPackageUrls(pkg, packageContent, sourceOrg, targetOrg, version.name);

    let filesToDownload = [];
    switch (pkg.package_type) {
      case 'maven':
      case 'gradle':
        filesToDownload = await listMavenPackageAssets(pkg.package_type, pkg.name, sourceOrg, version.name);
        break;
      case 'npm':
        filesToDownload = await listNPMPackageAssets(pkg.name, sourceOrg, version.name);
        break;
      case 'container':
        filesToDownload = await listContainerPackageAssets(pkg.name, sourceOrg, version);
        break;
      default:
        logger.warn(`Unsupported package type: ${pkg.package_type}`);
        return
    }

    if (!filesToDownload.length) {
      logger.warn(`No files found for package ${pkg.name} version ${version.name}`);
      return;
    }

    logger.debug(`Files to download: ${filesToDownload.join(', ')}`);

    if (dryRun) {
      logger.info(`[Dry Run] Would download ${filesToDownload.length} files for ${pkg.name} version ${version.name}`);
      logger.info(`[Dry Run] Would upload ${filesToDownload.length} files to ${uploadPackageUrl}`);
    } else {
      switch (pkg.package_type) {
        case 'maven':
        case 'gradle':
          for (const file of filesToDownload) {
            const fileUrl = `${downloadPackageUrl}/${file}`; // This is the correct URL now
            await downloadPackageFiles(fileUrl, pkg.name, file); // Pass just the filename, not an array
          }
          await uploadPackageFiles(uploadPackageUrl, pkg.name, filesToDownload);
          break;
        case 'npm':
          for (const file of filesToDownload) {
            const fileUrl = `${downloadPackageUrl}/${file}`; // This is the correct URL now
            await downloadPackageFiles(fileUrl, pkg.name, `${pkg.name}-${version.name}.tgz`);
          }
          await publishNpmPackage(targetOrg, pkg.name, version.name);
          break;
        case 'container':
          execSync(`docker login ghcr.io -u ${process.env.SOURCE_ORG} -p ${process.env.SOURCE_TOKEN}`);
          for (const file of filesToDownload) {
            const fileUrl = `${downloadPackageUrl}/${file}`; // This is the correct URL now
            await downloadPackageFiles(fileUrl, pkg.name, file);
          }
          execSync(`docker login ghcr.io -u ${process.env.TARGET_ORG} -p ${process.env.TARGET_TOKEN}`);
          await pushContainerPackage(downloadPackageUrl, uploadPackageUrl, pkg.name, filesToDownload, version);
          break;
      }
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
async function getPackageContent(sourceOctokit, sourceOrg, pkg, versionName) {
  const { data: packageContent } = await sourceOctokit.packages.getPackageForOrganization({
    package_type: pkg.package_type,
    package_name: pkg.name,
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
  if (fileUrl.includes('ghcr.io')) {
    execSync(`docker pull ${fileUrl}`);
    execSync(`docker save ${fileUrl} -o packages/${packageName}/${fileName}`);
  }
  else await downloadFile(fileUrl, `packages/${packageName}/${fileName}`);
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
 * @param {string} org - Target organization name
 * @param {string} packageName - Name of the package to publish
 * @param {string} packageVersion - Version of the package to publish
 * @returns {Promise<void>}
 * @throws {Error} If npm publish command fails or if files cannot be accessed
 */
async function publishNpmPackage(org, package_name, package_version) {
  const npmrc = `//npm.pkg.github.com/:_authToken=${TARGET_TOKEN}\nregistry=https://npm.pkg.github.com/${org}`;
  fs.writeFileSync(`packages/${package_name}/.npmrc`, npmrc);
  const pwd = `${process.cwd()}/packages/${package_name}`;

  let cwd = `packages/${package_name}`;
  const tgz = `${package_name}-${package_version}.tgz`;

  execSync(`tar -xzf ${tgz}`, { cwd });
  cwd = `${cwd}/package`;
  execSync(`npm publish --ignore-scripts --userconfig ${pwd}/.npmrc`, { cwd });

  fs.rmSync(`packages/${package_name}/package`, { recursive: true });
}

/**
 * @param {string} downloadPackageUrl - Base URL for downloading container images
 * @param {string} uploadPackageUrl - Base URL for uploading container images
 * @param {string} packageName - Name of the container package
 * @param {Array<string>} filesToUpload - Array of container image files to upload
 * @param {Object} version - Version information for the package
 * @returns {Promise<void>}
 * @throws {Error} If docker commands fail or if authentication fails
 */
async function pushContainerPackage(downloadPackageUrl, uploadPackageUrl, package_name, filesToUpload, version) {
  for (const file of filesToUpload) {
    logger.info(`retagging ${downloadPackageUrl}/${file} to ghcr.io/${process.env.TARGET_ORG}/${file}`);
    execSync(`docker tag ${downloadPackageUrl}/${file} ${uploadPackageUrl}/${file}`);
    logger.info(`pushing ghcr.io/${process.env.TARGET_ORG}/${file}`);
    execSync(`docker push ghcr.io/${process.env.TARGET_ORG}/${file}`);
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
    logger.warn(`Failed to download file ${url}, status: ${response.status}, message: ${response.statusText}`);
    return false;
  }
  const buffer = await response.arrayBuffer();
  // fs.writeFileSync(path, buffer);
  fs.writeFileSync(path, Buffer.from(buffer));
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
function getPackageUrls(pkg, packageContent, sourceOrg, targetOrg, versionName) {
  logger.debug('Package content:', JSON.stringify(packageContent, null, 2));

  const groupId = packageContent.name.split('.').slice(0, -1).join('.');
  const artifactId = packageContent.name.split('.').pop();
  const version = versionName;
  const repository = packageContent.repository.name;

  logger.debug(`Group ID: ${groupId}`);
  logger.debug(`Artifact ID: ${artifactId}`);
  logger.debug(`Version: ${version}`);
  logger.debug(`Repository: ${repository}`);

  let downloadBaseUrl, uploadBaseUrl, downloadPackageUrl, uploadPackageUrl;

  if (pkg.package_type == 'npm')
  {
    downloadBaseUrl = `https://${pkg.package_type}.pkg.github.com`;
    uploadBaseUrl = `https://${pkg.package_type}.pkg.github.com`;
    downloadPackageUrl = `${downloadBaseUrl}/download/@${sourceOrg}/${pkg.name}/${versionName}`;
    uploadPackageUrl = `${uploadBaseUrl}/@${targetOrg}/${repository}`;
  }
  else if (pkg.package_type == 'container')
  {
    downloadBaseUrl = `ghcr.io`;
    uploadBaseUrl = `ghcr.io`;
    downloadPackageUrl = `${downloadBaseUrl}/${sourceOrg}`;
    uploadPackageUrl = `${uploadBaseUrl}/${targetOrg}`;
  }
  else
  {
    downloadBaseUrl = `https://${pkg.package_type}.pkg.github.com/${sourceOrg}/${repository}`;
    uploadBaseUrl = `https://${pkg.package_type}.pkg.github.com/${targetOrg}/${repository}`;
    downloadPackageUrl = `${downloadBaseUrl}/${groupId}/${artifactId}/${version}`;
    uploadPackageUrl = `${uploadBaseUrl}/${groupId}/${artifactId}/${version}`;
  }

  logger.debug(`Download Base URL: ${downloadBaseUrl}`);
  logger.debug(`Upload Base URL: ${uploadBaseUrl}`);
  logger.debug(`Download Package URL: ${downloadPackageUrl}`);
  logger.debug(`Upload Package URL: ${uploadPackageUrl}`);

  return { groupId, artifactId, repository, downloadBaseUrl, uploadBaseUrl, downloadPackageUrl, uploadPackageUrl };
}

async function listNPMPackageAssets(package_name, org, package_version) {
  const npmUrl = `https://npm.pkg.github.com/@${org}/${package_name}`;
  const response = await fetch(npmUrl, {
    headers: {
      Authorization: `token ${SOURCE_TOKEN}`
    }
  });

  if (!response.ok) {
    logger.warn(`Failed to fetch package ${package_name}, status: ${response.status}, message: ${response.statusText}`);
    return [];
  }

  const npmJson = await response.json();
  const version = npmJson.versions[package_version];
  if (!version) {
    logger.warn(`Version ${package_version} not found for package ${package_name}`);
    return [];
  }

  const distTarball = version.dist.tarball.split('/').pop(-1);
  return [distTarball];
}

async function listContainerPackageAssets(package_name, org, version) {
  let files = []
  for (const tag of version.metadata.container.tags.reverse()) {
    files.push(`${package_name}:${tag}`);
  }
  return files;
}

/**
 * Lists package assets.
 * @param {string} package_type - Package type
 * @param {string} package_name - Package name
 * @param {string} org - Organization name
 * @param {string} package_version - Package version
 * @returns {Array} Array of asset names
 */
async function listMavenPackageAssets(package_type, package_name, org, package_version) {
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
