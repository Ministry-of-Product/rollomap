# RolloMap Documentation

Project documentation lives here. Start with the root
[README](../README.md) for install and usage, then dig in below.

## Vision & product

- [Philosophy](PHILOSOPHY.md) — local-first, you-own-your-data principles
- [Product requirements (PRD)](RolloMap_PRD.md) · [expanded](RolloMap_PRD_expanded.md)
- [User stories](rollomap_userstories.md) · [expanded](rollomap_userstories_expanded.md)

## Architecture & data

- [Source connectors](source-connectors.md) — how data gets in
- [Contact sharing](contact-sharing.md) — the sharing model
- [Sync conflict policy](sync-conflict-policy.md) — how cloud sync resolves conflicts
- [Sync testing](sync-testing.md) — how sync is exercised

## Related references

- REST API and MCP tools: see the [root README](../README.md#mcp-server)
- Database schema: [`db/migrations/`](../db)
- Operational helpers (cloud auto-sync): [`ops/`](../ops)

## Contributing

- [How to contribute](../CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Security policy](../SECURITY.md)
