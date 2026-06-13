# Security Policy

## Supported Versions

The project is pre-1.0. Security fixes target the current `main` branch unless maintainers document release branches later.

## Reporting a Vulnerability

Do not disclose suspected vulnerabilities publicly before maintainers have had time to investigate.

Use GitHub private vulnerability reporting or contact the maintainers through the repository's private security channel once it is configured. Include:

- affected package or scenario;
- reproduction steps;
- expected and actual behavior;
- impact assessment;
- relevant logs or traces with secrets removed.

## Secrets

Never commit API keys, `.env` files, production connector credentials, or model provider tokens. The repository ignores `.env`, but contributors should still review diffs before publishing.

## LLM and Connector Boundaries

Treat connector implementations as trusted integration code and workflow artifacts as business logic. Do not pass unvalidated connector outputs into irreversible command steps; validate inputs and outputs with the existing Zod schemas.
