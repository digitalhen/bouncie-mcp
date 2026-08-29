# Why OAuth kept failing, and how it was found

Notes from debugging a Claude.ai connector that would not authenticate against
`bouncie.digitalhen.com`, August 2026. Kept because the root cause is invisible
in the code and the false trails are easy to walk down again.

## The symptom

Connecting the MCP server from Claude.ai failed with a generic
`Authorization with Bouncie MCP failed`, and later with an explicit
`oauth_error=invalid_grant&error_code=mcp_token_exchange_failed`.

Occasionally it worked. That intermittency was the whole story, and it was
misread as progress for most of the investigation.

## The root cause

**Two instances served one hostname and shared nothing.** The deployment is
deliberately HA: two OrbStack → Dokploy hosts, fronted by Cloudflare, which
round-robins between them. They had no shared database, no shared volume, and no
session affinity.

Authorization state, authorization codes, access tokens, and MCP sessions all
lived in per-process memory (and later, a per-host JSON file). So roughly half of
every request landed on an instance that had never seen the flow:

| Request lands on the other instance | Observed failure |
|---|---|
| `/callback` after `/authorize` | `Invalid State` |
| `POST /token` after `/callback` | `invalid_grant` → `mcp_token_exchange_failed` |
| `POST /mcp` with a freshly issued token | `401`, then a re-registration loop |

Every request was a coin flip. That is why the failures looked intermittent,
unrelated to one another, and why each apparent "fix" seemed to half-work.

## The fix

The server now holds no state at all. See **Running more than one instance** in
the README and the stateless constraint in `CLAUDE.md`. Everything that used to
be remembered is now sealed into the value handed to the client.

## What was actually broken along the way

Three genuine defects were found and fixed before the root cause. All were real
and worth fixing; **none of them was the cause.**

1. **Missing OAuth discovery metadata.** `/.well-known/oauth-protected-resource`
   returned 404 and the `/mcp` 401 carried no `WWW-Authenticate` header, so a
   client had no documented way to find the flow. (RFC 9728 / MCP auth spec.)
2. **`GET /mcp` returned 400 instead of 405.** Claude.ai polls `GET /mcp`
   throughout the flow; a hard 400 where the spec expects 405 contributed to
   connection failures.
3. **No refresh token.** The token response carried only an access token, so a
   client had no way to renew a 24h session.

Two changes made during the investigation were self-inflicted and later reverted:

- An invented `scopes_supported: ["bouncie"]` was added to the metadata. Clients
  read it and dutifully requested a scope that means nothing to Bouncie. Do not
  advertise capabilities that do not exist.
- Auth-code persistence and a `/data` volume were added to survive restarts.
  Correct reasoning for a single instance, useless for two — each host simply got
  its own private file. Removed once the server became stateless.

## False trails, and why each was convincing

- **"It's a single instance."** A probe created one pending auth, then replayed
  the callback: first `500`, then `400` repeatedly. That was read as *the state
  was consumed on first use*. It is equally consistent with *request one hit host
  A and the rest hit host B* — which is what was happening. A test that cannot
  distinguish two hypotheses has not chosen between them.
- **"The token works, so auth is fine."** Tokens pulled from one host's store
  validated perfectly. They were being tested against the same host that minted
  them, through a load balancer that happened to route consistently for a short
  burst.
- **"The deploys are the problem."** Auto-deploy on push does drop both
  instances, and it genuinely broke several attempts mid-flow. It was a real
  contributing factor, which made it a very comfortable place to stop looking.
- **"Claude.ai never calls `/token`."** It did. The request landed on the *other*
  host, whose logs were not being read.

## How it was finally found

Registering six clients through the public URL and counting how many each host
had seen: **three and three.** Definitive, and it took one command.

## Lessons

- **Ask what the deployment topology is, and verify the answer.** The second host
  was mentioned early in the conversation and dismissed after a `docker ps` that
  returned no output — while `curl http://192.168.200.52:3002/health` had
  returned `200` in the same batch of commands. The evidence was already in hand
  and went unread.
- **Intermittent means stateful or plural, until proven otherwise.** A failure
  that succeeds one time in two is a routing or state-sharing question first.
- **Read the logs of every instance,** not the convenient one.
- **Instrument before hypothesising.** Every `/token` rejection returned a bare
  400 with no log line. Adding one line of logging per failure path turned an
  opaque failure into a readable one, and should have come first.
- **Do not deploy while someone is mid-flow** on an auto-deploying repo.
