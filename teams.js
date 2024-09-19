const { logger, setVerbosity } = require('./logger');

/**
 * Migrates teams from source organization to target organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {boolean} verbose - Whether to enable verbose logging
 */
async function migrateTeams(sourceOctokit, targetOctokit, sourceOrg, targetOrg, dryRun, verbose) {
  setVerbosity(verbose);
  logger.info('Starting team migration process...');

  try {
    const targetIdpGroups = await getTargetIdpGroupMappings(targetOctokit, targetOrg, dryRun);
    const teams = await fetchSourceTeams(sourceOctokit, sourceOrg);
    const sortedTeams = sortTeamsByHierarchy(teams);
    const teamMap = new Map();

    for (const team of sortedTeams) {
      await processTeam(sourceOctokit, targetOctokit, sourceOrg, targetOrg, team, teamMap, targetIdpGroups, dryRun);
    }

    const teamHierarchy = displayTeamHierarchy(sortedTeams, teamMap);
    logger.info('Team hierarchy:');
    logger.info(JSON.stringify(teamHierarchy, null, 2));
  } catch (error) {
    logger.error('Error migrating teams:', error.message);
  }
}

/**
 * Fetches IdP group mappings from the target organization.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} org - Target organization name
 * @param {boolean} dryRun - Whether this is a dry run
 * @returns {Array} Array of IdP groups
 */
async function getTargetIdpGroupMappings(targetOctokit, org, dryRun) {
  if (dryRun) {
    logger.info(`[Dry run] Would fetch IdP group mappings from target organization: ${org}`);
    return [];
  }

  logger.info(`Fetching IdP group mappings from target organization: ${org}`);
  try {
    const { data } = await targetOctokit.orgs.listIdpGroupsForOrg({ org });
    logger.info(`Successfully fetched ${data.groups.length} IdP groups from target organization: ${org}`);
    return data.groups;
  } catch (error) {
    logger.warn(`Unable to fetch IdP group mappings for target organization ${org}. This is not critical if you're not using IdP groups. Error: ${error.message}`);
    return [];
  }
}

/**
 * Fetches teams from the source organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @returns {Array} Array of teams
 */
async function fetchSourceTeams(sourceOctokit, sourceOrg) {
  logger.info(`Fetching teams from source organization: ${sourceOrg}`);
  const teams = await sourceOctokit.paginate(sourceOctokit.teams.list, {
    org: sourceOrg,
    per_page: 100
  });
  logger.info(`Found ${teams.length} teams in source organization: ${sourceOrg}`);
  return teams;
}

/**
 * Sorts teams based on their hierarchy.
 * @param {Array} teams - Array of teams
 * @returns {Array} Sorted array of teams
 */
function sortTeamsByHierarchy(teams) {
  return teams.sort((a, b) => {
    if (a.parent && a.parent.slug === b.slug) return 1;
    if (b.parent && b.parent.slug === a.slug) return -1;
    return 0;
  });
}

/**
 * Processes a single team for migration.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {Object} team - Team object to process
 * @param {Map} teamMap - Map to store processed teams
 * @param {Array} targetIdpGroups - Array of target IdP groups
 * @param {boolean} dryRun - Whether this is a dry run
 */
async function processTeam(sourceOctokit, targetOctokit, sourceOrg, targetOrg, team, teamMap, targetIdpGroups, dryRun) {
  logger.debug(`Processing team: ${team.name}`);

  try {
    const membersWithRoles = await fetchTeamMembers(sourceOctokit, sourceOrg, team);
    const idpGroup = getIdpGroupForTeam(team, targetIdpGroups);

    if (dryRun) {
      logDryRunInfo(team, idpGroup);
      teamMap.set(team.slug, { ...team, members: membersWithRoles, idpGroup });
    } else {
      await createTeamInTargetOrg(targetOctokit, targetOrg, team, teamMap, idpGroup, membersWithRoles);
    }
  } catch (error) {
    logger.error(`Error processing team ${team.name}: ${error.message}`);
  }
}

/**
 * Fetches members for a team with their roles.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @param {Object} team - Team object
 * @returns {Array} Array of team members with roles
 */
async function fetchTeamMembers(sourceOctokit, sourceOrg, team) {
  logger.debug(`Fetching members for team: ${team.name}`);
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
      logger.error(`Error fetching membership for ${member.login}:`, error.message);
      return null;
    }
  });

  return (await Promise.all(memberPromises)).filter(Boolean);
}

/**
 * Gets the IdP group for a team.
 * @param {Object} team - Team object
 * @param {Array} targetIdpGroups - Array of target IdP groups
 * @returns {Object|null} IdP group object or null
 */
function getIdpGroupForTeam(team, targetIdpGroups) {
  const envVarName = `${team.name.toUpperCase().replace(/ /g, '_')}_IDP_GROUP`;
  const idpGroupName = process.env[envVarName];
  logger.debug(`Looking for IdP group name in environment variable: ${envVarName}`);
  
  if (idpGroupName) {
    const idpGroup = findIdpGroupByName(targetIdpGroups, idpGroupName);
    if (idpGroup) {
      logger.debug(`Found matching IdP group for team ${team.name}: ${idpGroup.group_name}`);
      return idpGroup;
    } else {
      logger.warn(`Warning: IdP group name "${idpGroupName}" specified in .env file for team ${team.name} not found in target organization`);
    }
  } else {
    logger.debug(`No IdP group mapping specified for team ${team.name}`);
  }
  
  return null;
}

/**
 * Logs dry run information for a team.
 * @param {Object} team - Team object
 * @param {Object|null} idpGroup - IdP group object or null
 */
function logDryRunInfo(team, idpGroup) {
  logger.info(`[Dry run] Would create team: ${team.name}${team.parent ? ` (Parent: ${team.parent.name})` : ''}`);
  if (idpGroup) {
    logger.info(`[Dry run] Would apply IdP group mapping: ${idpGroup.group_name}`);
  }
}

/**
 * Creates a team in the target organization.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {Object} team - Team object to create
 * @param {Map} teamMap - Map to store processed teams
 * @param {Object|null} idpGroup - IdP group object or null
 * @param {Array} membersWithRoles - Array of team members with roles
 */
async function createTeamInTargetOrg(targetOctokit, targetOrg, team, teamMap, idpGroup, membersWithRoles) {
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
      if (parentTeam && parentTeam.id) {
        newTeamData.parent_team_id = parentTeam.id;
      }
    }

    logger.info(`Creating team in target organization: ${team.name}`);
    const { data: newTeam } = await targetOctokit.teams.create(newTeamData);

    if (idpGroup) {
      await applyIdpGroupMapping(targetOctokit, targetOrg, newTeam, idpGroup);
    }

    teamMap.set(team.slug, { ...newTeam, members: membersWithRoles, idpGroup });

    logger.info(`Successfully created team: ${newTeam.name}${team.parent ? ` (Parent: ${team.parent.name})` : ''}`);

    await migrateTeamMembers(targetOctokit, targetOrg, newTeam, membersWithRoles);
    await migrateTeamRepositories(targetOctokit, targetOrg, team, newTeam);
  } catch (error) {
    logger.error(`Error creating team ${team.name} in target organization: ${error.message}`);
  }
}

/**
 * Applies IdP group mapping to a team.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {Object} newTeam - Newly created team object
 * @param {Object} idpGroup - IdP group object
 */
async function applyIdpGroupMapping(targetOctokit, targetOrg, newTeam, idpGroup) {
  logger.info(`Applying IdP group mapping for team ${newTeam.name}: ${idpGroup.group_name}`);
  await targetOctokit.teams.updateSyncGroupMappings({
    org: targetOrg,
    team_slug: newTeam.slug,
    groups: [idpGroup]
  });
  logger.info(`Successfully applied IdP group mapping for team ${newTeam.name}: ${idpGroup.group_name}`);
}

/**
 * Migrates team members to the new team.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {Object} newTeam - Newly created team object
 * @param {Array} membersWithRoles - Array of team members with roles
 */
async function migrateTeamMembers(targetOctokit, targetOrg, newTeam, membersWithRoles) {
  logger.info(`Migrating members for team: ${newTeam.name}`);
  for (const member of membersWithRoles) {
    try {
      await targetOctokit.teams.addOrUpdateMembershipForUserInOrg({
        org: targetOrg,
        team_slug: newTeam.slug,
        username: member.login,
        role: member.role
      });
      logger.debug(`Added ${member.login} to team ${newTeam.name} with role ${member.role}`);
    } catch (error) {
      logger.warn(`Unable to add ${member.login} to team ${newTeam.name}: ${error.message}`);
    }
  }
}

/**
 * Migrates team repositories to the new team.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {Object} team - Original team object
 * @param {Object} newTeam - Newly created team object
 */
async function migrateTeamRepositories(targetOctokit, targetOrg, team, newTeam) {
  logger.info(`Migrating repositories for team: ${newTeam.name}`);
  try {
    const repos = await targetOctokit.paginate(targetOctokit.teams.listReposInOrg, {
      org: targetOrg,
      team_slug: newTeam.slug,
      per_page: 100
    });

    for (const repo of repos) {
      try {
        await targetOctokit.teams.addOrUpdateRepoPermissionsInOrg({
          org: targetOrg,
          team_slug: newTeam.slug,
          owner: targetOrg,
          repo: repo.name,
          permission: repo.permissions.admin ? 'admin' : (repo.permissions.push ? 'push' : 'pull')
        });
        logger.debug(`Added repository ${repo.name} to team ${newTeam.name} with permissions ${repo.permissions.admin ? 'admin' : (repo.permissions.push ? 'push' : 'pull')}`);
      } catch (error) {
        logger.warn(`Unable to set permissions for repository ${repo.name} in team ${newTeam.name}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error(`Error migrating repositories for team ${newTeam.name}: ${error.message}`);
  }
}

/**
 * Displays team hierarchy with members and IdP mappings.
 * @param {Array} teams - Array of teams
 * @param {Map} teamMap - Map of processed teams
 * @param {string|null} parentSlug - Parent team slug
 * @param {number} level - Current hierarchy level
 * @returns {Array} Array representing team hierarchy
 */
function displayTeamHierarchy(teams, teamMap, parentSlug = null, level = 0) {
  const idpGroupOverride = process.env.IDP_GROUP_OVERRIDE;
  const teamIdpGroups = {};
  const result = [];

  if (idpGroupOverride) {
    const overrideValues = idpGroupOverride.split(',');
  
    if (overrideValues.length === 1) {
      teamIdpGroups.default = overrideValues[0];
    } else {
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
        idpGroup: teamIdpGroups[team.name] || teamIdpGroups.default || (teamInfo.idpGroup ? teamInfo.idpGroup.group_name : null),
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

/**
 * Finds an IdP group by name.
 * @param {Array} groups - Array of IdP groups
 * @param {string} name - Name of the IdP group to find
 * @returns {Object|undefined} The found IdP group or undefined
 */
function findIdpGroupByName(groups, name) {
  return groups.find(group => group.group_name === name);
}

module.exports = { migrateTeams };