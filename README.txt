HOOPERS KEY LOGIN — MULTI-PC VERSION

Features:
- Discord commands: /createkey, /keyinfo, /disablekey, /enablekey, /resetkey, /disableaccount, /enableaccount, /ping
- Shared PostgreSQL account/license/session storage for users on multiple PCs
- One-time key activation using a database transaction
- Password hashes, random session tokens, HTTPS-ready API, security headers, and auth rate limiting

Read README_DEPLOY.txt before deploying. You must host the API and database, configure Discord environment variables, and set API_BASE_URL in the HTA to the deployed HTTPS URL. This package does not create a live server automatically.

For production use, monitor the service, configure backups, review current host/database limits, and load-test before inviting many users.
