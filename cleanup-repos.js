require('dotenv').config();
const { Octokit } = require("@octokit/rest");

const token = process.env.TARGET_ORG_PAT;
const orgName = process.env.TARGET_ORG;

if (!token || !orgName) {
  console.error("Error: TARGET_ORG_PAT and TARGET_ORG must be set in the .env file");
  process.exit(1);
}

const octokit = new Octokit({ auth: token });

async function deleteAllRepos() {
  try {
    // Get all repositories for the organization
    const { data: repos } = await octokit.repos.listForOrg({
      org: orgName,
      per_page: 100
    });

    console.log(`Found ${repos.length} repositories in ${orgName}.`);

    // Delete each repository
    for (const repo of repos) {
      console.log(`Deleting ${repo.name}...`);
      await octokit.repos.delete({
        owner: orgName,
        repo: repo.name
      });
      console.log(`${repo.name} deleted successfully.`);
    }

    console.log("All repositories have been deleted.");
  } catch (error) {
    console.error("An error occurred:", error.message);
  }
}

deleteAllRepos();