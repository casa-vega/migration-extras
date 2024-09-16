const { mkdtempSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { execSync } = require('child_process');

async function migrateLFSObjects(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun) {
    const result = {
        repositories: [],
        errors: [],
    };

    console.log(`Checking all repositories in ${sourceOrg} for LFS usage...`);

    try {
        const repos = await sourceOctokit.paginate(sourceOctokit.repos.listForOrg, {
            org: sourceOrg,
            per_page: 100
        });

        for (const repo of repos) {
            const usesLFS = await checkLFSUsage(sourceOctokit, sourceOrg, repo.name);
            result.repositories.push({
                name: repo.name,
                usesLFS,
            });
        }

    } catch (error) {
        result.errors.push({ message: error.message });
    }

    if (!dryRun) {
        const lfsRepos = result.repositories.filter(repo => repo.usesLFS).map(repo => repo.name);
        await migrateLFS(sourceOrg, targetOrg, lfsRepos);
    }

    process.stdout.write(JSON.stringify(result));
}

async function checkLFSUsage(octokit, owner, repo) {
    const maxDepth = process.env.MAX_DEPTH || 1;
    async function searchDirectory(path = '', depth = 0) {
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
                    if (item.type === 'file' && item.name === '.gitattributes') {
                        const { data: fileContent } = await octokit.repos.getContent({
                            owner,
                            repo,
                            path: item.path,
                            mediaType: { format: "raw" },
                        });
                        if (fileContent.includes('filter=lfs')) {
                            return true;
                        }
                    } else if (item.type === 'dir') {
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
                    await new Promise(resolve => setTimeout(resolve, 1000)); // wait 1 second before retrying
                } else {
                    return false;
                }
            }
        }
    }
    return searchDirectory();
}

async function migrateLFS(sourceOrg, targetOrg, lfsRepos) {
    console.log(`Migrating LFS objects from source organization: ${sourceOrg} to target organization: ${targetOrg}`);

    for (const repoName of lfsRepos) {
        console.log(`Migrating LFS objects for repository: ${repoName}`);
        try {
            const tempDir = mkdtempSync(join(tmpdir(), `repo-migration-${repoName}`));
            try {
                // Clone the repository
                console.log(`Cloning repository: ${repoName}`);
                execSync(`git clone https://x-access-token:${process.env.SOURCE_ORG_PAT}@github.com/${sourceOrg}/${repoName}.git ${tempDir}`);

                // Change the remote URL
                console.log(`Updating remote URL for: ${repoName}`);
                execSync(`cd ${tempDir} && git remote set-url origin https://github.com/${targetOrg}/${repoName}.git`);

                // Migrate LFS objects
                // Change the Git config to use the target PAT for the LFS push
                console.log(`Updating Git config to use target PAT for LFS push for repository: ${repoName}`);
                execSync(`cd ${tempDir} && git config --add lfs.https://github.com/${targetOrg}/${repoName}.git.basic true && git config --add lfs.https://github.com/${targetOrg}/${repoName}.git.username github-actions && git config --add lfs.https://github.com/${targetOrg}/${repoName}.git.password ${process.env.TARGET_ORG_PAT}`);
                console.log(`Migrating LFS objects for repository: ${repoName}`);
                execSync(`cd ${tempDir} && git lfs fetch --all && git lfs push --all origin`);

                // Reset the Git config back to default
                console.log(`Resetting Git config after LFS push for repository: ${repoName}`);
                execSync(`cd ${tempDir} && git config --unset-all lfs.https://github.com/${targetOrg}/${repoName}.git.basic && git config --unset-all lfs.https://github.com/${targetOrg}/${repoName}.git.username && git config --unset-all lfs.https://github.com/${targetOrg}/${repoName}.git.password`);
            } finally {
                rmSync(tempDir, { recursive: true });
            }
        } catch (error) {
            console.error(`Error migrating LFS objects for repository ${repoName}:`, error.message);
        }
    }
}

module.exports = { migrateLFSObjects };