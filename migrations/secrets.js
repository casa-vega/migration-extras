import {writeFileSync, readFileSync} from "fs";
import {stringify} from "csv-stringify/sync";
import {parse} from "csv-parse/sync";
import sodium from 'libsodium-wrappers';
import {logger, setVerbosity} from '../logger.js';

/**
 * Migrates secrets from source organization to target organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrgToUse - Source organization name
 * @param {string} targetOrgToUse - Target organization name
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {boolean} verbose - Whether to enable verbose logging
 */
export async function migrateSecrets(sourceOctokit, targetOctokit, sourceOrgToUse, targetOrgToUse, dryRun, verbose) {
    setVerbosity(verbose);
    logger.info(`Starting secrets migration from ${sourceOrgToUse} to ${targetOrgToUse}`);
    logger.info(`Dry run: ${dryRun}`);

    if (dryRun) {
        await performDryRun(sourceOctokit, sourceOrgToUse);
    } else {
        await migrateSecretsWithDryRunCheck(sourceOctokit, targetOctokit, sourceOrgToUse, targetOrgToUse);
    }

    logger.info('Secrets migration completed');
}

/**
 * Performs a dry run, checking for secrets across all repositories and the organization.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrgToUse - Source organization name
 */
async function performDryRun(sourceOctokit, sourceOrgToUse) {
    logger.info("Performing dry-run check for secrets across all repositories and the organization...");

    try {
        const outputData = [["Type", "Repository/Organization", "Secret Name"]];

        await checkOrganizationSecrets(sourceOctokit, sourceOrgToUse, outputData);
        await checkRepositorySecrets(sourceOctokit, sourceOrgToUse, outputData);

        const outputCsv = stringify(outputData);
        const outputFileName = "secrets_check_results.csv";
        writeFileSync(outputFileName, outputCsv);

        logger.info(`Dry-run check complete. Results written to ${outputFileName}`);
        logger.info(`Total secrets found: ${outputData.length - 1}`);
    } catch (error) {
        logger.error("Error during secrets check:", error.message);
    }
}

/**
 * Checks for organization secrets.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrgToUse - Source organization name
 * @param {Array} outputData - Array to store output data
 */
async function checkOrganizationSecrets(sourceOctokit, sourceOrgToUse, outputData) {
    logger.info(`Checking organization secrets for: ${sourceOrgToUse}`);
    try {
        const { data: orgSecrets } = await sourceOctokit.actions.listOrgSecrets({
            org: sourceOrgToUse,
        });

        for (const secret of orgSecrets.secrets) {
            outputData.push(["Organization", sourceOrgToUse, secret.name]);
        }
    } catch (error) {
        logger.error(`Error fetching organization secrets:`, error.message);
    }
}

/**
 * Checks for repository secrets.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrgToUse - Source organization name
 * @param {Array} outputData - Array to store output data
 */
async function checkRepositorySecrets(sourceOctokit, sourceOrgToUse, outputData) {
    const repos = await sourceOctokit.paginate(sourceOctokit.repos.listForOrg, {
        org: sourceOrgToUse,
        per_page: 100,
    });
    logger.info(`Found ${repos.length} repositories in organization: ${sourceOrgToUse}`);

    await Promise.all(repos.map(async (repo) => {
        logger.debug(`Checking secrets for repo: ${repo.name}`);
        try {
            const { data: repoSecrets } = await sourceOctokit.actions.listRepoSecrets({
                owner: sourceOrgToUse,
                repo: repo.name,
            });

            for (const secret of repoSecrets.secrets) {
                outputData.push(["Repository", repo.name, secret.name]);
            }
        } catch (error) {
            logger.error(`Error fetching secrets for repo ${repo.name}:`, error.message);
        }
    }));
}

/**
 * Migrates secrets using data from a CSV file.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrgToUse - Source organization name
 * @param {string} targetOrgToUse - Target organization name
 */
async function migrateSecretsWithDryRunCheck(sourceOctokit, targetOctokit, sourceOrgToUse, targetOrgToUse) {
    logger.info("Migrating secrets...");

    const secretsCsv = "secrets_to_migrate.csv";

    try {
        const secrets = loadSecretsFromCsv(secretsCsv);
        logger.info(`Found ${secrets.length} secrets to migrate.`);

        await sodium.ready;
        const orgPublicKey = await getOrgPublicKey(targetOctokit, targetOrgToUse);

        await Promise.all(secrets.map(secret => 
            processSecret(sourceOctokit, targetOctokit, sourceOrgToUse, targetOrgToUse, secret, orgPublicKey)
        ));
    } catch (error) {
        logger.error("Error migrating secrets:", error.message);
    }
}

/**
 * Loads secrets from a CSV file.
 * @param {string} filename - Name of the CSV file
 * @returns {Array} Array of secret objects
 */
function loadSecretsFromCsv(filename) {
    const secretsData = readFileSync(filename, "utf8");
    return parse(secretsData, {
        columns: true,
        skip_empty_lines: true,
    });
}

/**
 * Gets the public key for the organization.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrgToUse - Target organization name
 * @returns {Object} Public key object
 */
async function getOrgPublicKey(targetOctokit, targetOrgToUse) {
    const { data: orgPublicKey } = await targetOctokit.actions.getOrgPublicKey({
        org: targetOrgToUse,
    });
    return orgPublicKey;
}

/**
 * Processes a single secret.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} sourceOrgToUse - Source organization name
 * @param {string} targetOrgToUse - Target organization name
 * @param {Object} secret - Secret object to process
 * @param {Object} orgPublicKey - Organization public key
 */
async function processSecret(sourceOctokit, targetOctokit, sourceOrgToUse, targetOrgToUse, secret, orgPublicKey) {
    const { type, repo, name, value } = secret;
    logger.debug(`Processing secret: ${name} for ${type === 'org' ? 'organization' : 'repo'}: ${repo || targetOrgToUse}`);

    try {
        const publicKey = type === 'repo' ? await getRepoPublicKey(targetOctokit, targetOrgToUse, repo) : orgPublicKey;
        const encryptedValue = encryptSecret(value, publicKey.key);

        if (type === 'repo') {
            await createOrUpdateRepoSecret(targetOctokit, targetOrgToUse, repo, name, encryptedValue, publicKey.key_id);
        } else if (type === 'org') {
            const existingSecret = await getExistingOrgSecret(sourceOctokit, sourceOrgToUse, name);
            await createOrUpdateOrgSecret(targetOctokit, targetOrgToUse, name, encryptedValue, publicKey.key_id, existingSecret.visibility);
        }
    } catch (error) {
        logger.error(`Error processing secret ${name} in ${type === 'org' ? 'organization' : 'repo'} ${repo || targetOrgToUse}:`, error.message);
    }
}

/**
 * Gets the public key for a repository.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrgToUse - Target organization name
 * @param {string} repo - Repository name
 * @returns {Object} Public key object
 */
async function getRepoPublicKey(targetOctokit, targetOrgToUse, repo) {
    const { data: repoPublicKey } = await targetOctokit.actions.getRepoPublicKey({
        owner: targetOrgToUse,
        repo: repo,
    });
    return repoPublicKey;
}

/**
 * Encrypts a secret value.
 * @param {string} value - Secret value to encrypt
 * @param {string} publicKey - Public key to use for encryption
 * @returns {string} Encrypted value
 */
function encryptSecret(value, publicKey) {
    const messageBytes = Buffer.from(value, 'utf8');
    const keyBytes = Buffer.from(publicKey, 'base64');
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
    return Buffer.from(encryptedBytes).toString('base64');
}

/**
 * Creates or updates a repository secret.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrgToUse - Target organization name
 * @param {string} repo - Repository name
 * @param {string} name - Secret name
 * @param {string} encryptedValue - Encrypted secret value
 * @param {string} keyId - Key ID
 */
async function createOrUpdateRepoSecret(targetOctokit, targetOrgToUse, repo, name, encryptedValue, keyId) {
    await targetOctokit.actions.createOrUpdateRepoSecret({
        owner: targetOrgToUse,
        repo: repo,
        secret_name: name,
        encrypted_value: encryptedValue,
        key_id: keyId,
    });
    logger.info(`Created/Updated secret: ${name} in repo ${repo}`);
}

/**
 * Gets an existing organization secret.
 * @param {Object} sourceOctokit - Octokit instance for source organization
 * @param {string} sourceOrgToUse - Source organization name
 * @param {string} name - Secret name
 * @returns {Object} Existing secret object
 */
async function getExistingOrgSecret(sourceOctokit, sourceOrgToUse, name) {
    const { data: existingSecret } = await sourceOctokit.actions.getOrgSecret({
        org: sourceOrgToUse,
        secret_name: name,
    });
    return existingSecret;
}

/**
 * Creates or updates an organization secret.
 * @param {Object} targetOctokit - Octokit instance for target organization
 * @param {string} targetOrgToUse - Target organization name
 * @param {string} name - Secret name
 * @param {string} encryptedValue - Encrypted secret value
 * @param {string} keyId - Key ID
 * @param {string} visibility - Secret visibility
 */
async function createOrUpdateOrgSecret(targetOctokit, targetOrgToUse, name, encryptedValue, keyId, visibility) {
    await targetOctokit.actions.createOrUpdateOrgSecret({
        org: targetOrgToUse,
        secret_name: name,
        encrypted_value: encryptedValue,
        key_id: keyId,
        visibility: visibility,
    });
    logger.info(`Created/Updated secret: ${name} in organization ${targetOrgToUse}`);
}
