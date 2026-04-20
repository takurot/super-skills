# SKAP Cross-Machine Access Runbook

*SKAP Phase D: docs/specs/2026-04-21-aios-shared-knowledge-access-
protocol.md §5 Phase D. Added 2026-04-20.*

How to let an AI client (Gemini, Codex, a second Claude) on a
**different machine** call AIOS shared-knowledge endpoints that
currently bind only to `127.0.0.1:3150`.

**Do NOT publish AIOS to the open internet.** All options below
terminate at the same loopback port via a private tunnel.

---

## Options (in order of preference)

### Option 1 — Tailscale (recommended)

**Why**: single binary per machine, WireGuard under the hood, no
port-forwarding, ACLs per device.

**Setup (on the AIOS host, Mac):**

```
brew install tailscale
sudo tailscaled install-system-daemon
sudo tailscale up
tailscale ip -4   # note the 100.x.x.x address — call this AIOS_IP
```

**Confirm AIOS is reachable locally**:

```
curl -sS http://127.0.0.1:3150/health
# {"status":"healthy", ...}
```

**Publish the port inside tailnet only** (SKAP is per-user — the
loopback bind is intentional; we expose via Tailscale-Serve which
stays inside the tailnet):

```
tailscale serve --bg --tcp=3150 tcp://127.0.0.1:3150
```

Verify from another tailnet machine:

```
curl -sS http://AIOS_IP:3150/aios/bootstrap \
  -H "X-Vcontext-Admin: yes"
```

**Client setup (AI on second machine):**

- Set `VCTX_URL=http://AIOS_IP:3150` in the environment
- Set `VCTX_ADMIN_TOKEN` (value from `~/.aios/token` on the host)
- The client reads both on startup and passes `X-Vcontext-Admin:
  yes` + the token on every call

### Option 2 — SSH tunnel (ad-hoc / debugging)

From the client machine:

```
ssh -L 3150:127.0.0.1:3150 user@aios-host.local
# Keep this terminal open for the duration of the session.
```

Then, in another terminal on the client:

```
curl -sS http://127.0.0.1:3150/aios/bootstrap \
  -H "X-Vcontext-Admin: yes"
```

No server-side changes needed. Fine for one-off runs; not for
persistent sessions because the tunnel dies with the ssh session.

### Option 3 — ngrok / cloudflared (NOT recommended)

Exposes AIOS to the public internet even with a random hostname.
Use only if you can gate with HTTP Basic auth or client-cert and
can accept the additional attack surface. Not covered in this
runbook.

---

## Auth token handling

AIOS endpoints gate admin actions on the `X-Vcontext-Admin: yes`
header. That header is paper-thin (it's a literal "yes"); the real
protection is **network reachability** — so never punch a port
open to the internet.

Per-machine secret (`~/.aios/token`) lands with a future hardening
commit. Until then, treat `X-Vcontext-Admin: yes` as "you had to
be on the tailnet to send this".

---

## Client-side configuration

### Generic MCP-compatible client

1. Fetch the manifest once at client startup:

   ```
   curl -sS http://AIOS_IP:3150/aios/mcp-manifest
   ```

2. For each tool in the manifest's `tools[]`, register a local
   tool with the given `name` and `inputSchema`.

3. On tool invocation, resolve the tool name to the `resolves_to`
   URL + method + auth. Pass through inputs as query-string or
   body depending on `method`. Add `X-Vcontext-Admin: yes` when
   the spec requires it.

### Claude Desktop / Claude Code

Add to the user's MCP config (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "aios": {
      "url": "http://AIOS_IP:3150/aios/mcp-manifest",
      "type": "http-manifest"
    }
  }
}
```

(Adjust format per your Claude Desktop version — `type:
"http-manifest"` is not yet official MCP; SKAP Phase E will
publish a bridge process that speaks real MCP stdio.)

### Gemini / Codex

Use the CLI's generic tool-registration hook. Each vendor's
interface differs; the manifest JSON is the stable contract.

---

## Verification checklist

From the second machine:

- [ ] `curl http://AIOS_IP:3150/health` returns `{"status":"healthy"}`
- [ ] `curl /aios/bootstrap` (with admin header) returns the 4+
      lesson-learned entries
- [ ] ETag round-trip: a second call with `If-None-Match: <etag>`
      returns 304
- [ ] `curl /aios/mcp-manifest` returns the 4 tool definitions
- [ ] A tool call via your MCP-bridge pathway routes to
      `resolves_to.url` without transformation errors

---

## Security notes

1. **Never expose 3150 to the open internet.** SKAP has no TLS and
   no per-request auth beyond `X-Vcontext-Admin`. Treat it as a
   per-user daemon behind a VPN.
2. **Token in transit**: Tailscale/SSH provide transport
   encryption. HTTP plaintext to the loopback endpoint over a
   tailnet link is fine; the same plaintext over the open
   internet is not.
3. **Write path** (`POST /store`): gated by API-key + role. Even
   on the tailnet, issuing a member-tier key to another AI host
   is an explicit decision — don't hand the default key to a
   machine you don't fully control.
4. **Audit**: every admin call appears in `admin-op` entries on
   the server. `GET /recall?type=admin-op&session=admin-op` gives
   the forensic trail.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Couldn't connect` | host not in tailnet, or port 3150 not serving | `tailscale status` on both ends; `tailscale serve status` |
| `403 X-Vcontext-Admin required` | client didn't send header | Add `-H 'X-Vcontext-Admin: yes'` |
| `503 ramdb_unavailable` | server restarting / unhealthy | Check host `/health` directly |
| `304` on first call | stale `If-None-Match` passed | Drop the header on the first call |
| Manifest `base_url` = `127.0.0.1` | client is reading it as absolute | Override via env `VCTX_URL`; don't trust server-rendered base_url across machines |

---

## Source of truth

This runbook documents the current shape of SKAP Phase A (`/aios/
bootstrap`) + Phase C (`/aios/mcp-manifest`). If endpoint contracts
change, the OpenAPI spec
(`docs/schemas/vcontext-api-v1.yaml`) wins over this runbook.
