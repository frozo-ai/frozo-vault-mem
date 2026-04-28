# Security Policy

## Reporting security issues

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security vulnerabilities via GitHub Security Advisories:

**[https://github.com/frozo-ai/frozo-vault-mem/security/advisories/new](https://github.com/frozo-ai/frozo-vault-mem/security/advisories/new)**

Alternatively, you can email the maintainer at **security@frozo.ai** — note that this address may need updating; if you get a bounce, use the GitHub advisory link above.

We aim to acknowledge reports within 48 hours and to publish a fix or mitigation within 14 days for confirmed vulnerabilities. We will credit reporters in the release notes unless you request otherwise.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1   | No        |

Only the latest patch release in the `0.1.x` series receives security fixes.

## Threat model and scope

vault-mem is a **local-first** tool. The server runs as a stdio-only MCP process; it opens no network sockets and has no HTTP surface. The threat model is: what could a malicious agent or compromised process running with your user account do through the MCP interface?

Relevant design decisions that affect the attack surface:

- **stdio-only transport.** The MCP server communicates only over stdin/stdout. No ports are bound. A malicious process cannot reach it over the network.
- **Schema validation on every write.** All frontmatter is validated against versioned JSON Schemas before being written to disk. This prevents agents from injecting arbitrary YAML fields that could confuse downstream consumers (the keeper daemon, Obsidian).
- **Audit log with hashed queries.** Every operation (write, read, search, promote, context) is appended to `_system/audit.log` in JSONL format. Search queries are recorded as SHA-256 hashes — raw query text is never persisted in the audit log, reducing PII exposure if the vault is shared or backed up.
- **Atomic writes with file locking.** Vault mutations use `proper-lockfile` + temp-file rename to prevent torn writes. A crashed MCP process does not leave partial files.
- **Inbox isolation.** Agent writes land in `inbox/<type>/` first. The Python keeper is the only process that moves files into `memory/`. This means a compromised agent cannot silently overwrite canonical memories.

### What is NOT in scope for this project

- Multi-user vaults, collaboration, or access control lists
- Network-exposed endpoints or cloud sync
- Encryption at rest (the vault is plain markdown; encrypt your home directory at the OS level if you need this)

If you find a way to escalate from "agent can call MCP tools" to "agent can execute arbitrary code on the host" or "agent can silently corrupt the vault in a way the audit log does not record," that is a serious vulnerability and should be reported privately.
