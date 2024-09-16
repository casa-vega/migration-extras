const { writeFileSync, readFileSync } = require("fs");
const { stringify } = require("csv-stringify/sync");
const { parse } = require("csv-parse/sync");
const sodium = require('libsodium-wrappers');


async function migrateSecrets(
    sourceOctokit,
    targetOctokit,
    sourceOrgToUse,
    targetOrgToUse,
    dryRun
) {
    if (dryRun) {
        console.log(
            "Performing dry-run check for secrets across all repositories and the organization..."
        );

        try {
            const outputData = [["Type", "Repository/Organization", "Secret Name"]];

            // Check organization secrets
            console.log(`Checking organization secrets for: ${sourceOrgToUse}`);
            try {
                const { data: orgSecrets } = await sourceOctokit.actions.listOrgSecrets({
                    org: sourceOrgToUse,
                });

                for (const secret of orgSecrets.secrets) {
                    outputData.push(["Organization", sourceOrgToUse, secret.name]);
                }
            } catch (error) {
                console.error(`Error fetching organization secrets:`, error.message);
            }

            // Check repository secrets
            const repos = await sourceOctokit.paginate(sourceOctokit.repos.listForOrg, {
                org: sourceOrgToUse,
                per_page: 100,
            });
            console.log(
                `Found ${repos.length} repositories in organization: ${sourceOrgToUse}`
            );

            for (const repo of repos) {
                console.log(`Checking secrets for repo: ${repo.name}`);

                try {
                    const { data: repoSecrets } =
                        await sourceOctokit.actions.listRepoSecrets({
                            owner: sourceOrgToUse,
                            repo: repo.name,
                        });

                    for (const secret of repoSecrets.secrets) {
                        outputData.push(["Repository", repo.name, secret.name]);
                    }
                } catch (error) {
                    console.error(
                        `Error fetching secrets for repo ${repo.name}:`,
                        error.message
                    );
                }
            }

            const outputCsv = stringify(outputData);
            const outputFileName = "secrets_check_results.csv";
            writeFileSync(outputFileName, outputCsv);

            console.log(`Dry-run check complete. Results written to ${outputFileName}`);
            console.log(`Total repositories checked: ${repos.length}`);
            console.log(`Total secrets found: ${outputData.length - 1}`);
        } catch (error) {
            console.error("Error during secrets check:", error.message);
        }
    } else {
        await migrateSecretsWithDryRunCheck(
            sourceOctokit,
            targetOctokit,
            sourceOrgToUse,
            targetOrgToUse,
            dryRun
        );
    }
}

async function migrateSecretsWithDryRunCheck(
    sourceOctokit,
    targetOctokit,
    sourceOrgToUse,
    targetOrgToUse,
    dryRun
) {
    if (dryRun) {
        console.log(
            "Performing dry-run check for secrets across all repositories and the organization..."
        );
    }

    console.log("Migrating secrets...");

    const secretsCsv = "secrets_to_migrate.csv"; // Static file name for secrets CSV

    try {
        const secretsData = readFileSync(secretsCsv, "utf8");
        const secrets = parse(secretsData, {
            columns: true,
            skip_empty_lines: true,
        });
        console.log(`Found ${secrets.length} secrets to migrate.`);

        // Initialize libsodium
        await sodium.ready;

        // Retrieve the public key for the organization
        const { data: orgPublicKey } = await targetOctokit.actions.getOrgPublicKey({
            org: targetOrgToUse,
        });

        for (const secret of secrets) {
            const { type, repo, name, value } = secret;
            console.log(`Processing secret: ${name} for ${type === 'org' ? 'organization' : 'repo'}: ${repo || targetOrgToUse}`);

            try {
                let publicKey;
                if (type === 'repo') {
                    // Fetch repository-specific public key
                    const { data: repoPublicKey } = await targetOctokit.actions.getRepoPublicKey({
                        owner: targetOrgToUse,
                        repo: repo,
                    });
                    publicKey = repoPublicKey;
                } else {
                    publicKey = orgPublicKey;
                }

                // Encrypt the secret value using the appropriate public key
                const messageBytes = Buffer.from(value, 'utf8');
                const keyBytes = Buffer.from(publicKey.key, 'base64');
                const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
                const encryptedValue = Buffer.from(encryptedBytes).toString('base64');

                if (type === 'repo') {
                    await targetOctokit.actions.createOrUpdateRepoSecret({
                        owner: targetOrgToUse,
                        repo: repo,
                        secret_name: name,
                        encrypted_value: encryptedValue,
                        key_id: publicKey.key_id,
                    });
                    console.log(`Created/Updated secret: ${name} in repo ${repo}`);
                } else if (type === 'org') {
                    // Fetch existing secret details to get the visibility
                    const { data: existingSecret } = await sourceOctokit.actions.getOrgSecret({
                        org: sourceOrgToUse,
                        secret_name: name,
                    });

                    await targetOctokit.actions.createOrUpdateOrgSecret({
                        org: targetOrgToUse,
                        secret_name: name,
                        encrypted_value: encryptedValue,
                        key_id: publicKey.key_id,
                        visibility: existingSecret.visibility, // Inherit visibility
                    });
                    console.log(`Created/Updated secret: ${name} in organization ${targetOrgToUse}`);
                }
            } catch (error) {
                console.error(
                    `Error creating/updating secret ${name} in ${type === 'org' ? 'organization' : 'repo'} ${repo || targetOrgToUse}:`,
                    error.message
                );
            }
        }
    } catch (error) {
        console.error("Error migrating secrets:", error.message);
    }
}

module.exports = { migrateSecrets };
