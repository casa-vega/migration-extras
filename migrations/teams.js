import {logger, setVerbosity} from '../logger.js';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

/**
 * Reads and parses the username mapping CSV file.
 * @param {string} csvPath - Path to the CSV file
 * @returns {Map} Map of source usernames to target usernames
 */
function loadUsernameMappings(csvPath) {
  try {
    if (!csvPath) {
      logger.info('No username mapping CSV provided, proceeding with original usernames');
      return new Map();
    }

    const fileContent = fs.readFileSync(csvPath, 'utf-8');
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const mappings = new Map();
    records.forEach(record => {
      const sourceUsername = record.sourceUsername || record['source username'];
      const targetUsername = record.targetUsername || record['target username'];
      
      if (sourceUsername && targetUsername) {
        mappings.set(sourceUsername, targetUsername);
        logger.debug(`Loaded username mapping: ${sourceUsername} → ${targetUsername}`);
      }
    });

    logger.info(`Loaded ${mappings.size} username mappings from CSV`);
    return mappings;
  } catch (error) {
    logger.error(`Error loading username mappings: ${error.message}`);
    return new Map();
  }
}

/**
 * Migrates teams from source organization to target organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {Object} sourceGraphQL - GraphQL client for source (not used)
 * @param {Object} targetGraphQL - GraphQL client for target (not used)
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {string} packageType - Package type (not used)
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {boolean} verbose - Whether to enable verbose logging
 * @param {string} [usernameMappingFile] - Path to CSV file containing username mappings
 */
export async function migrateTeams(
  sourceOctokit, 
  targetOctokit, 
  sourceGraphQL,
  targetGraphQL,
  sourceOrg, 
  targetOrg,
  packageType,
  dryRun, 
  verbose,
  usernameMappingFile
) {
  setVerbosity(verbose);
  logger.info('Starting team migration process...');

  try {
    const usernameMappings = loadUsernameMappings(usernameMappingFile);
    const teams = await fetchSourceTeams(sourceOctokit, sourceOrg);
    const sortedTeams = sortTeamsByHierarchy(teams);
    const teamMap = new Map();

    for (const team of sortedTeams) {
      await processTeam(sourceOctokit, targetOctokit, sourceOrg, targetOrg, team, teamMap, dryRun, usernameMappings);
    }

    const teamHierarchy = displayTeamHierarchy(sortedTeams, teamMap, usernameMappings);
    logger.info('Team hierarchy:');
    logger.info(JSON.stringify(teamHierarchy, null, 2));
  } catch (error) {
    logger.error('Error migrating teams:', error.message);
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
 * Fetches repositories for a team with their permissions.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrg - Source organization name
 * @param {Object} team - Team object
 * @returns {Array} Array of repositories with permissions
 */
async function fetchTeamRepositories(sourceOctokit, sourceOrg, team) {
  logger.debug(`Fetching repositories for team: ${team.name}`);
  try {
    const repos = await sourceOctokit.paginate(sourceOctokit.teams.listReposInOrg, {
      org: sourceOrg,
      team_slug: team.slug,
      per_page: 100
    });

    return repos.map(repo => ({
      name: repo.name,
      permission: repo.permissions.admin ? 'admin' : (repo.permissions.push ? 'push' : 'pull')
    }));
  } catch (error) {
    logger.error(`Error fetching repositories for team ${team.name}:`, error.message);
    return [];
  }
}

/**
 * Processes a single team for migration.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrg - Source organization name
 * @param {string} targetOrg - Target organization name
 * @param {Object} team - Team object to process
 * @param {Map} teamMap - Map to store processed teams
 * @param {boolean} dryRun - Whether this is a dry run
 * @param {Map} usernameMappings - Map of source usernames to target usernames
 */
async function processTeam(sourceOctokit, targetOctokit, sourceOrg, targetOrg, team, teamMap, dryRun, usernameMappings) {
  logger.debug(`Processing team: ${team.name}`);

  try {
    const membersWithRoles = await fetchTeamMembers(sourceOctokit, sourceOrg, team);
    const repositories = await fetchTeamRepositories(sourceOctokit, sourceOrg, team);

    if (dryRun) {
      logger.info(`[Dry run] Would create team: ${team.name}${team.parent ? ` (Parent: ${team.parent.name})` : ''}`);
      
      // Log repository details
      repositories.forEach(repo => {
        logger.info(`[Dry run] Would add repository ${repo.name} with ${repo.permission} permission`);
      });
      
      // Log username mappings
      membersWithRoles.forEach(member => {
        const targetUsername = usernameMappings.get(member.login) || member.login;
        if (targetUsername !== member.login) {
          logger.info(`[Dry run] Would map user ${member.login} to ${targetUsername}`);
        }
      });
      
      teamMap.set(team.slug, { ...team, members: membersWithRoles, repositories });
    } else {
      await createTeamInTargetOrg(targetOctokit, targetOrg, team, teamMap, membersWithRoles, repositories, usernameMappings);
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
 * Creates a team in the target organization.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {Object} team - Team object to create
 * @param {Map} teamMap - Map to store processed teams
 * @param {Array} membersWithRoles - Array of team members with roles
 * @param {Array} repositories - Array of repositories with permissions
 * @param {Map} usernameMappings - Map of source usernames to target usernames
 */
async function createTeamInTargetOrg(targetOctokit, targetOrg, team, teamMap, membersWithRoles, repositories, usernameMappings) {
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

    teamMap.set(team.slug, { ...newTeam, members: membersWithRoles, repositories });

    logger.info(`Successfully created team: ${newTeam.name}${team.parent ? ` (Parent: ${team.parent.name})` : ''}`);

    await migrateTeamMembers(targetOctokit, targetOrg, newTeam, membersWithRoles, usernameMappings);
    await migrateTeamRepositories(targetOctokit, targetOrg, newTeam, repositories);
  } catch (error) {
    logger.error(`Error creating team ${team.name} in target organization: ${error.message}`);
  }
}

/**
 * Migrates team members to the new team.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {Object} newTeam - Newly created team object
 * @param {Array} membersWithRoles - Array of team members with roles
 * @param {Map} usernameMappings - Map of source usernames to target usernames
 */
async function migrateTeamMembers(targetOctokit, targetOrg, newTeam, membersWithRoles, usernameMappings) {
  logger.info(`Migrating members for team: ${newTeam.name}`);
  for (const member of membersWithRoles) {
    try {
      const targetUsername = usernameMappings.get(member.login) || member.login;
      
      if (targetUsername !== member.login) {
        logger.debug(`Mapping user ${member.login} to ${targetUsername}`);
      }

      await targetOctokit.teams.addOrUpdateMembershipForUserInOrg({
        org: targetOrg,
        team_slug: newTeam.slug,
        username: targetUsername,
        role: member.role
      });
      logger.debug(`Added ${targetUsername} to team ${newTeam.name} with role ${member.role}`);
    } catch (error) {
      logger.warn(`Unable to add ${member.login} to team ${newTeam.name}: ${error.message}`);
    }
  }
}

/**
 * Migrates team repositories to the new team.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrg - Target organization name
 * @param {Object} newTeam - Newly created team object
 * @param {Array} repositories - Array of repositories with permissions
 */
async function migrateTeamRepositories(targetOctokit, targetOrg, newTeam, repositories) {
  logger.info(`Migrating ${repositories.length} repositories for team: ${newTeam.name}`);
  
  for (const repo of repositories) {
    try {
      await targetOctokit.teams.addOrUpdateRepoPermissionsInOrg({
        org: targetOrg,
        team_slug: newTeam.slug,
        owner: targetOrg,
        repo: repo.name,
        permission: repo.permission
      });
      logger.debug(`Added repository ${repo.name} to team ${newTeam.name} with permission ${repo.permission}`);
    } catch (error) {
      logger.warn(`Unable to set permissions for repository ${repo.name} in team ${newTeam.name}: ${error.message}`);
    }
  }
}

/**
 * Displays team hierarchy with members and repository details.
 * @param {Array} teams - Array of teams
 * @param {Map} teamMap - Map of processed teams
 * @param {Map} usernameMappings - Map of source usernames to target usernames
 * @param {string|null} parentSlug - Parent team slug
 * @param {number} level - Current hierarchy level
 * @returns {Array} Array representing team hierarchy
 */
function displayTeamHierarchy(teams, teamMap, usernameMappings, parentSlug = null, level = 0) {
  const result = [];

  teams
    .filter(team => (parentSlug === null && !team.parent) || (team.parent && team.parent.slug === parentSlug))
    .forEach(team => {
      const teamInfo = teamMap.get(team.slug);
      const teamData = {
        name: team.name,
        members: teamInfo.members ? teamInfo.members.map(member => {
          const targetUsername = usernameMappings.get(member.login) || member.login;
          return {
            sourceLogin: member.login,
            targetLogin: targetUsername,
            role: member.role
          };
        }) : [],
        repositories: teamInfo.repositories ? teamInfo.repositories.map(repo => ({
          name: repo.name,
          permission: repo.permission
        })) : []
      };
      result.push(teamData);
      const childTeams = displayTeamHierarchy(teams, teamMap, usernameMappings, team.slug, level + 1);
      if (childTeams.length > 0) {
        teamData.children = childTeams;
      }
    });
  return result;
}
