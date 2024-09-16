async function migrateTeams(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun) {
  console.log('Starting team migration process...');

  try {
    console.log(`Fetching IdP groups from target organization: ${targetOrg}`);
    const targetIdpGroups = dryRun ? [] : await getTargetIdpGroupMappings(targetOctokit, targetOrg);

    console.log(`Fetching teams from source organization: ${sourceOrg}`);
    const teams = await sourceOctokit.paginate(sourceOctokit.teams.list, {
      org: sourceOrg,
      per_page: 100
    });

    console.log(`Found ${teams.length} teams in source organization: ${sourceOrg}`);

    // Sort teams based on their hierarchy
    const sortedTeams = teams.sort((a, b) => {
      if (a.parent && a.parent.slug === b.slug) return 1;
      if (b.parent && b.parent.slug === a.slug) return -1;
      return 0;
    });

    const teamMap = new Map();

    for (const team of sortedTeams) {
      //console.log(`Processing team: ${team.name}`);

      // Fetch team members with their roles
      //console.log(`Fetching members for team: ${team.name}`);
      const members = await sourceOctokit.paginate(sourceOctokit.teams.listMembersInOrg, {
        org: sourceOrg,
        team_slug: team.slug,
        per_page: 100
      });

      const memberPromises = members.map(async (member) => {
        try {
          const membership = await sourceOctokit.teams.getMembershipForUserInOrg({
            org: sourceOrg,
            team_slug: team.slug,
            username: member.login,
          });

          return {
            login: member.login,
            role: membership.data.role,
          };
        } catch (error) {
          console.error(`Error fetching membership for ${member.login}:`, error.message);
          return null;
        }
      });

      const membersWithRoles = await Promise.all(memberPromises);

      // Get IdP group name from .env file
      const envVarName = `${team.name.toUpperCase().replace(/ /g, '_')}_IDP_GROUP`;
      const idpGroupName = process.env[envVarName];
      //console.log(`Looking for IdP group name in environment variable: ${envVarName}`);
      const idpGroup = idpGroupName ? findIdpGroupByName(targetIdpGroups, idpGroupName) : null;

      if (idpGroup) {
        //console.log(`Found matching IdP group for team ${team.name}: ${idpGroup.group_name}`);
      } else if (idpGroupName) {
        //console.log(`Warning: IdP group name "${idpGroupName}" specified in .env file for team ${team.name} not found in target organization`);
      } else {
        console.log(`No IdP group mapping specified for team ${team.name}`);
      }

      if (dryRun) {
        //console.log(`[Dry run] Would create team: ${team.name}${team.parent ? ` (Parent: ${team.parent.name})` : ''}`);
        if (idpGroup) {
          //console.log(`[Dry run] Would apply IdP group mapping: ${idpGroup.group_name}`);
        }
        teamMap.set(team.slug, { ...team, members: membersWithRoles, idpGroup });
      } else {
        try {
          const newTeamData = {
            org: targetOrg,
            name: team.name,
            description: team.description,
            privacy: team.privacy,
            permission: team.permission
          };

          if (team.parent) {
            const parentTeam = teamMap.get(team.parent.slug);
            if (parentTeam) {
              newTeamData.parent_team_id = parentTeam.id;
            }
          }

          //console.log(`Creating team in target organization: ${team.name}`);
          const { data: newTeam } = await targetOctokit.teams.create(newTeamData);

          // Apply IdP group mapping if available
          if (idpGroup) {
            //console.log(`Applying IdP group mapping for team ${newTeam.name}: ${idpGroup.group_name}`);
            await targetOctokit.teams.updateSyncGroupMappings({
              org: targetOrg,
              team_slug: newTeam.slug,
              groups: [idpGroup]
            });
            //console.log(`Successfully applied IdP group mapping for team ${newTeam.name}: ${idpGroup.group_name}`);
          }

          teamMap.set(team.slug, { ...newTeam, members: membersWithRoles, idpGroup });

          //console.log(`Successfully created team: ${newTeam.name}${team.parent ? ` (Parent: ${team.parent.name})` : ''}`);

          // Migrate team members
          //console.log(`Migrating members for team: ${newTeam.name}`);
          for (const member of membersWithRoles) {
            if (member) {
              await targetOctokit.teams.addOrUpdateMembershipForUserInOrg({
                org: targetOrg,
                team_slug: newTeam.slug,
                username: member.login,
                role: member.role
              });
              //console.log(`Added ${member.login} to team ${newTeam.name} with role ${member.role}`);
            }
          }

          // Migrate team repositories
          console.log(`Migrating repositories for team: ${newTeam.name}`);
          const repos = await sourceOctokit.paginate(sourceOctokit.teams.listReposInOrg, {
            org: sourceOrg,
            team_slug: team.slug,
            per_page: 100
          });

          for (const repo of repos) {
            await targetOctokit.teams.addOrUpdateRepoPermissionsInOrg({
              org: targetOrg,
              team_slug: newTeam.slug,
              owner: targetOrg,
              repo: repo.name,
              permission: repo.permissions.admin ? 'admin' : (repo.permissions.push ? 'push' : 'pull')
            });
            //console.log(`Added repository ${repo.name} to team ${newTeam.name} with permissions ${repo.permissions.admin ? 'admin' : (repo.permissions.push ? 'push' : 'pull')}`);
          }
        } catch (error) {
          console.error(`Error processing team ${team.name}:`, error.message);
        }
      }
    }
    // Display team hierarchy with members and IdP mappings
    // console.log('\nTeam Hierarchy, Members, and IdP Mappings:');
    // displayTeamHierarchy(sortedTeams, teamMap);
    const teamHierarchy = displayTeamHierarchy(sortedTeams, teamMap);
    console.log(JSON.stringify(teamHierarchy, null, 2));
  } catch (error) {
    console.error('Error migrating teams:', error.message);
  }
}

async function getTargetIdpGroupMappings(targetOctokit, org) {
  console.log(`Fetching IdP group mappings from target organization: ${org}`);
  try {
    const { data } = await targetOctokit.orgs.listIdpGroupsForOrg({
      org,
    });
    console.log(`Successfully fetched ${data.groups.length} IdP groups from target organization: ${org}`);
    return data.groups;
  } catch (error) {
    console.error(`Error fetching IdP group mappings for target organization ${org}:`, error.message);
    return [];
  }
}

function displayTeamHierarchy(teams, teamMap, parentSlug = null, level = 0) {
  const idpGroupOverride = process.env.IDP_GROUP_OVERRIDE;
  const teamIdpGroups = {};
  const result = [];

  if (idpGroupOverride) {
    // Check if the override is a single value or a comma-separated list of team-specific values
    const overrideValues = idpGroupOverride.split(',');
  
    if (overrideValues.length === 1) {
      // Single override for all teams
      teamIdpGroups.default = overrideValues[0];
    } else {
      // Individual overrides for each team
      overrideValues.forEach((teamIdpGroup) => {
        const [team, idpGroup] = teamIdpGroup.split('=');
        teamIdpGroups[team] = idpGroup;
      });
    }
  }

  teams
    .filter(team => (parentSlug === null && !team.parent) || (team.parent && team.parent.slug === parentSlug))
    .forEach(team => {
      const teamInfo = teamMap.get(team.slug);
      const teamData = {
        name: team.name,
        idpGroup: teamIdpGroups[team.name] || teamIdpGroups.default,
        members: teamInfo.members ? teamInfo.members.map(member => ({
          login: member.login,
          role: member.role
        })) : []
      };
      result.push(teamData);
      const childTeams = displayTeamHierarchy(teams, teamMap, team.slug, level + 1);
      if (childTeams.length > 0) {
        teamData.children = childTeams;
      }
    });
  return result;
}

function findIdpGroupByName(groups, name) {
  const match = groups.find(group => group.group_name === name);
}

module.exports = { migrateTeams };
