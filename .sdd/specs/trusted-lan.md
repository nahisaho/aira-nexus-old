---
feature: trusted-lan
tier: T2
approval: human
---
# Dedicated Nginx trusted-LAN access
Goal: serve the existing single-user workspace at http://192.168.11.10:3000 through dedicated Nginx; keep the application at 127.0.0.1:3000 without public Internet deployment or new identities.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-LAN-001 | When the owner starts the dedicated Nginx proxy with a valid AIRA_PUBLIC_ORIGIN, the system shall bind only that assigned private IPv4 and public port, proxy to the loopback application, preserve existing data and single-writer semantics, and release only its owned proxy processes and lock on graceful stop. | TEST-LAN-001 |
| REQ-LAN-002 | If AIRA_PUBLIC_ORIGIN is empty or not a canonical http://assigned-RFC1918-IPv4:1024..65535 origin without credentials/path/query/fragment, application and proxy startup shall fail explicitly before state creation, writer acquisition or listening; an absent setting shall keep normal application startup loopback-only and reject proxy startup. | TEST-LAN-002 |
| REQ-LAN-003 | When the dedicated proxy forwards requests, it shall preserve Host/Origin, clear Forwarded and X-Forwarded-Host/Proto/For/Port/Server, reject other syntactically valid Hosts and socket peers outside RFC1918/127.0.0.1 with 403, stream requests/responses without whole-body buffering, and pass bodies up to 100 MiB while rejecting larger declared bodies with 413 before forwarding. | TEST-LAN-003 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-LAN-001` | actual Nginx serves UI/assets/API and retained project; app remains loopback; missing/unconfigured upstream, PORT0 and existing/stale proxy locks refused; own spawned processes/lock released | wildcard/direct-app LAN bind, lost data, PID-file signalling, leaked proxy or changes to existing service/state | TEST-LAN-001 | unrun |
| `REQ-LAN-002` | valid assigned origin accepted; unset app remains local; malformed/leading-zero/whitespace/mapped/link-local/CGNAT/public/unassigned/credentialed origins fail before state/lock/credentials | silent fallback or startup effects before rejection | TEST-LAN-002 | unrun |
| `REQ-LAN-003` | real HTTP preserves Host/Origin, clears authority spoofs, delivers SSE while upstream held and upstream refusal before upload ends; 2 MiB passes and >100 MiB declared fails before upstream | origin masking, trusted spoof, whole-body buffering or default 1 MiB cap; app still enforces 12 MiB non-upload/100 MiB upload limits | TEST-LAN-003, TEST-PROJECT-004 | unrun |
## Design
Use AIRA_PUBLIC_ORIGIN=http://192.168.11.10:3000 for app/proxy; validate canonical IPv4, RFC1918 membership, interface assignment and unprivileged explicit port. App PORT0 remains valid; proxy uses matching actual nonzero PORT (default3000), rejects PORT0, and requires loopback GET /api/projects with configured public Host/Origin to return200 before LAN listening. App always binds127.0.0.1; no AIRA_LAN_HOST direct bind.
Explicit installation verifies Ubuntu amd64 nginx1.28.3-2ubuntu1.12 archive sha256:190e602e4b54cf629c6f625ae1513241db404311c2af98720695b210a6dbe86b and extracts privately under .aira-proxy (AIRA_PROXY_DIR override); no auto-install, root, package hooks, systemd/global config or existing-service changes. Binary/config/PID/locks/temp/log paths stay private. Any existing lock, including stale, causes refusal: no automatic recovery or PID-file signalling; cleanup signals/waits only spawned process handles and removes only its own lock.
Nginx uses exact public Host and socket-peer RFC1918/127.0.0.1 ACLs, never forwarded peer identity; preserve Host/Origin, clear Forwarded/X-Forwarded-Host/Proto/For/Port/Server, disable request/response buffering/cache, set100 MiB ingress cap. Malformed HTTP can be rejected400 by Nginx; valid unallowed Host/peer combinations return403. Actual127.0.0.2 source tests ACL denial, including spoofed X-Forwarded-For, without host IP changes. Retain capacity/body/upload/framing guards and execution/disclosure confirmations.
## Assumptions / risks
Owner selected Nginx LAN publication after accepting unauthenticated shared-owner authority. Retain HTTP/no login/no TLS/no multi-user isolation; a firewall/proxy is not authentication/encryption, and local OS users can bypass the proxy. No firewall/router/IP changes are authorized; reachability is not permission for automatic execution.
Pinned package and synthetic loopback Nginx/header/SSE/2 MiB/413/graceful-exit spike passed; exact192.168.11.10:3000 bind closed without serving research (nginx-proxy-spike.json, nginx-exact-lan-port-spike.json). This retires host-local feasibility only; off-device reachability and a standalone cross-distro package remain unqualified.
