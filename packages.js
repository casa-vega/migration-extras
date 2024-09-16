const fetch = require('node-fetch');
const fs = require('fs');
const { graphql } = require("@octokit/graphql");

const auth = {
  sourceOrgPAT: process.env.SOURCE_ORG_PAT,
  targetOrgPAT: process.env.TARGET_ORG_PAT,
}


async function downloadFile(url, path, auth) {
  // use curl equivalent to -u USERNAME:TOKEN
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${auth.sourceOrgPAT}`
    }
  });
  if (!response.ok) {
    console.warn(`Failed to download file ${file}, status: ${response.status}, message: ${response.statusText}`);
    return false;
  }
  const buffer = await response.buffer();
  fs.writeFileSync(path, buffer);
  return true;
}

async function listPackageAssets(package_type, package_name, org, package_version, auth) {
  const result = await graphql(`
    {
      organization(login: "${org}") {
        packages(last: 1, names: "${package_name}") {
          nodes {
            version(version: "${package_version}") {
              files(first: 100) {
                nodes {
                  name
                }
              }
            }
          }
        }
      }
    }`,
    {
      headers: {
        authorization: `token ${auth.sourceOrgPAT}`,
      },
    }
  );

  var assets = []
  for (const node of result.organization.packages.nodes[0].version.files.nodes) {
    assets.push(node.name);
  }
  return assets;
}

async function migratePackages(sourceOctokit, targetOctokit, sourceOrg, targetOrg, auth, dryRun) {
  console.log('Starting package migration process...');

  try {

    // Delete packages directory if exists
    if (fs.existsSync('packages')) {
      fs.rmSync('packages', { recursive: true });
    }
    fs.mkdirSync('packages');

    // Fetch all packages in the organization
    const { data: packages } = await sourceOctokit.packages.listPackagesForOrganization({
      package_type: 'maven',
      org: sourceOrg
    });

    console.log(`Found ${packages.length} packages in organization: ${sourceOrg}`);

    for (const pkg of packages) {
      console.log(`Processing package: ${pkg.name}`);

      try {
        // Check if repo exists in target org
        await targetOctokit.repos.get({
          owner: targetOrg,
          repo: pkg.repository.name
        });
      } catch (repoError) {
        console.log(`Repository ${pkg.repository.name} not found in target organization. Skipping...`);
        continue;
      }

      // TODO: comment back
      try {
        // Check if the package already exists in the target repository
        await targetOctokit.packages.getPackageForOrganization({
          package_type: 'maven',
          package_name: pkg.name,
          org: targetOrg
        });
        console.log(`Package ${pkg.name} already exists in target organization. Skipping...`);
        continue;
      } catch (packageError) {
        // Package doesn't exist, we can proceed with migration
      }

      if (dryRun) {
        console.log(`[Dry run] Would migrate package: ${pkg.name} from ${sourceOrg} to ${targetOrg}`);
        continue;
      }

      // Fetch all versions of the package
      const { data: versions } = await sourceOctokit.packages.getAllPackageVersionsForPackageOwnedByOrg({
        package_type: 'maven',
        package_name: pkg.name,
        org: sourceOrg
      });

      console.log(`Found ${versions.length} versions of the package ${pkg.name}`);

      for (const version of versions) {
        console.log(`Migrating version: ${version.name}`);

        try {
          // Get package information
          const { data: packageContent } = await sourceOctokit.packages.getPackageForOrganization({
            package_type: 'maven',
            package_name: pkg.name,
            org: sourceOrg,
            version: version.name
          });
          const groupId = packageContent.name.split('.').slice(0, -1).join('.');
          const artifactId = packageContent.name.split('.').pop();
          const repository = packageContent.repository.name;
          const downloadBaseUrl = `https://maven.pkg.github.com/${sourceOrg}/${repository}`;
          const uploadBaseUrl = `https://maven.pkg.github.com/${targetOrg}/${repository}`;
          const downloadPackageUrl = `${downloadBaseUrl}/${groupId}/${artifactId}/${version.name}`;
          const uploadPackageUrl = `${uploadBaseUrl}/${groupId}/${artifactId}/${version.name}`;
          const filesToDownload = await listPackageAssets('maven', pkg.name, sourceOrg, version.name, auth);
          var filesToUpload = [];

          // Attempt to download all files 

          fs.mkdirSync(`packages/${pkg.name}`, { recursive: true });
          for (const file of filesToDownload) {
            console.log(`Downloading ${downloadPackageUrl}/${file}`);
            await downloadFile(`${downloadPackageUrl}/${file}`, `packages/${pkg.name}/${file}`, auth);
            filesToUpload.push(file);
          }

          for (const file of filesToUpload) {
            try {
              const fileContent = fs.readFileSync(`packages/${pkg.name}/${file}`);
              
              let headers = {
                Authorization: `token ${auth.targetOrgPAT}`,
                'Content-Length': fileContent.length
              };

              if (file.endsWith('.pom')) {
                headers['Content-Type'] = 'application/xml';
              } else if (file.endsWith('.jar')) {
                headers['Content-Type'] = 'application/java-archive';
              } else {
                headers['Content-Type'] = 'application/octet-stream';
              }

              console.log(`Uploading to ${uploadPackageUrl}/${file}`);
              const response = await fetch(`${uploadPackageUrl}/${file}`, {
                method: 'PUT',
                headers: headers,
                body: fileContent
              });

              if (!response.ok) {
                console.warn(`Failed to upload package ${pkg.name} version ${version.name}, status: ${response.status}, file: ${file}, message: ${response.statusText}`);
                continue;
              }

              console.log(`Successfully uploaded ${file}`);

            } catch (uploadError) {
              console.error(`Error uploading package ${pkg.name} version ${version.name}:`, uploadError.message);
              continue;
            }
          }
          console.log(`Migrated version ${version.name} of ${pkg.name}`);
        } catch (versionError) {
          console.error(`Error migrating version ${version.name} of ${pkg.name}:`, versionError.message);
          continue
        }
      }

      console.log(`Successfully processed package ${pkg.name}`);
    }
  } catch (error) {
    console.error('Error migrating packages:', error.message);
  }
}

module.exports = migratePackages;