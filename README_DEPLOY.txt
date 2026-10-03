HOOPERS MULTI-PC API (POSTGRESQL)

This version uses PostgreSQL (shared across all users) rather than a local JSON file, transactions for one-time key activation, connection pooling, security headers, and login/registration rate limiting. It is a starting point for small-to-medium deployments, not a load-tested or audited high-scale service. Increase hosting/database capacity and DB_POOL_MAX carefully as usage grows.

DEPLOY TO RENDER
1. Extract this folder and upload its CONTENTS to a private GitHub repository. Do not upload .env or secrets.
2. In Render, create a Blueprint from the repo and deploy render.yaml. It defines a web service and a managed PostgreSQL database; select plans that meet your needs and budget.
3. In the web service environment settings, set DISCORD_TOKEN, CLIENT_ID, GUILD_ID, ADMIN_USER_IDS, and a long random ADMIN_API_SECRET. DATABASE_URL is wired from the database in the Blueprint.
4. Deploy. Open https://YOUR-SERVICE.onrender.com/health. Expect {"ok":true,"database":"connected"}.
5. In the service shell or a local terminal using the same environment, run `npm run deploy` once to register Discord slash commands. If using Render, use its Shell if available, or run the command locally with the same Discord variables.
6. Set API_BASE_URL in the HTA to the real service HTTPS URL, without a trailing slash. Reopen the HTA.
7. Test /ping in Discord, then create a test key with /createkey days:1 and activate it in the HTA.

MULTI-PC NOTES
- All PCs use the same HTTPS API URL and PostgreSQL database. Do not run a separate local database for each user.
- Render's web service and database are billable; check current pricing and limits before deploying.
- Start with one API instance and a small database; monitor latency, errors, CPU, memory, DB connections, and request rates. Scale the service and database plan only after measuring real load. Keep total DB pool connections within the database connection limit.
- Configure database backups/PITR if offered by your plan. Test restore procedures before relying on it.
- Rate limiting here is per API process/IP; for multiple API instances, use a shared rate-limit store such as Redis.
- Keep Discord bot token, database URL/password, and ADMIN_API_SECRET private. Rotate any secret that leaks.
- HTTPS is required for public use. The HTA is only a launcher gate and cannot prevent someone from running Hoopers.exe directly.
