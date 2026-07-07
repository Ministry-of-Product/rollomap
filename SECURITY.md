# Security Policy

We take the security of RolloMap seriously. RolloMap is a local-first tool that
holds personal relationship data, so we especially appreciate reports that help
keep that data safe.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through
[**GitHub Security Advisories**](https://github.com/Ministry-of-Product/rollomap/security/advisories/new).
This creates a private channel visible only to the maintainers, where we can
discuss and fix the issue before it is disclosed publicly.

Please include as much of the following as you can:

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof-of-concept
- Affected version, commit, or component (API, MCP server, webapp, sync)
- Any suggested remediation

## What to Expect

- **Acknowledgement:** we aim to acknowledge your report within a few business
  days.
- **Assessment:** we will investigate, confirm the issue, and keep you updated
  on our progress.
- **Fix & disclosure:** once a fix is ready, we will coordinate a disclosure
  timeline with you and credit you in the release notes (unless you prefer to
  remain anonymous).

## Scope

Because RolloMap runs locally and stores data on the user's own machine, please
keep the following in mind when assessing severity:

- The default local setup binds services to `localhost` and ships with
  well-known development credentials (see `.env.example`). Operators are
  expected to change these before exposing any service beyond their own machine.
- Reports that require an attacker to already have full local access to the
  host, or that depend on the user intentionally weakening the default
  configuration, are lower priority — but still welcome.

Thank you for helping keep RolloMap and its users safe.
