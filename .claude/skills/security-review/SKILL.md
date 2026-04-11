---
name: security-review
description: |
  Security review workflow for app code, secrets handling, MCP risks, and agentic
  attack surface. Use when code touches auth, user input, external tools, secrets,
  file access, or high-trust automation.
origin: unified
user-invocable: true
---

# Security Review

## Coverage

- secrets management
- validation and injection risks
- authn and authz
- supply chain and dependency exposure
- MCP and plugin trust boundaries

## Output

Report issues by severity and include concrete remediation guidance.
