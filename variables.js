async function migrateVariables(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun) {
  const variableMigrations = {
    variables: [],
    errors: [],
  };

  try {
    const sourceRepos = await sourceOctokit.paginate(sourceOctokit.repos.listForOrg, {
      org: sourceOrg,
      per_page: 100,
    });

    const promises = sourceRepos.map(async (repo) => {
      try {
        const variables = await sourceOctokit.paginate(
          sourceOctokit.actions.listRepoVariables,
          {
            owner: sourceOrg,
            repo: repo.name,
            per_page: 100,
          }
        );

        const variablePromises = variables.map(async (variable) => {
          if (dryRun) {
            try {
              await targetOctokit.actions.createRepoVariable({
                owner: targetOrg,
                repo: repo.name,
                name: variable.name,
                value: variable.value,
              });

              variableMigrations.variables.push({
                repo: repo.name,
                name: variable.name,
                value: variable.value,
              });
            } catch (error) {
              variableMigrations.errors.push({
                repo: repo.name,
                name: variable.name,
                message: error.message,
              });
            }
          } else {
            variableMigrations.variables.push({
              repo: repo.name,
              name: variable.name,
              value: variable.value,
            });
          }
        });

        await Promise.all(variablePromises);
      } catch (error) {
        variableMigrations.errors.push({
          repo: repo.name,
          message: error.message,
        });
      }
    });

    await Promise.all(promises);

    // Migrate organization variables
    const orgVariables = await sourceOctokit.paginate(
      sourceOctokit.actions.listOrgVariables,
      {
        org: sourceOrg,
        per_page: 100,
      }
    );

    const orgVariablePromises = orgVariables.map(async (variable) => {
      if (!dryRun) {
        try {
          await targetOctokit.actions.createOrgVariable({
            org: targetOrg,
            name: variable.name,
            value: variable.value,
            visibility: variable.visibility,
            selected_repository_ids: variable.selected_repository_ids,
          });

          variableMigrations.variables.push({
            org: targetOrg,
            name: variable.name,
            value: variable.value,
          });
        } catch (error) {
          variableMigrations.errors.push({
            org: targetOrg,
            name: variable.name,
            message: error.message,
          });
        }
      } else {
        variableMigrations.variables.push({
          org: targetOrg,
          name: variable.name,
          value: variable.value,
        });
      }
    });

    await Promise.all(orgVariablePromises);
  } catch (error) {
    variableMigrations.errors.push({
      message: error.message,
    });
  }

  console.log(JSON.stringify(variableMigrations, null, 2));
}

module.exports = { migrateVariables };
