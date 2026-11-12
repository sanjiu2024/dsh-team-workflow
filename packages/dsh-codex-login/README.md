# dsh-codex-login

**Sign in with ChatGPT (Codex) for DeepSeek Harness — and make the provider refuse to exist until you do.**

DeepSeek Harness 0.2.2-rc.1 ships everything needed to run GPT models on a ChatGPT
subscription, except a way to start the sign-in. This plugin adds the missing surface, plus a
guard that stops you from saving a provider that can never work.

## The gap

| Layer | State |
| --- | --- |
| pi-ai catalog | `openai-codex` is there: `env: []` (**no API key by design**), `baseURL: https://chatgpt.com/backend-api` |
| OAuth implementation | complete — `loginOpenAICodex` (browser callback on :1455), `loginOpenAICodexDeviceCode`, `refreshOpenAICodexToken` |
| dsh registration | `dsh-llm-pi-ai` registers `authorization.registerFlow(...)` for every catalog provider, **unconditionally** |
| **UI consumer** | **none** — `authorization.list()` has zero call sites; the Models page never mentions `authorization` |

So opening `openai-codex` in Settings → Models shows only "API address" and "model catalog".
There is no key to paste, so the provider is **unreachable from the GUI**.

## What this plugin does

```
POST /codex-login/start    → begin a device-code sign-in, returns immediately with the code
GET  /codex-login/status   → idle / pending / authorized / failed / cancelled
POST /codex-login/cancel   → withdraw the attempt
codex_login (tool)         → same actions for an agent
```

On success the credential lands in `~/.dsh/.credentials.yaml` as
`llm-pi-ai/openai-codex` (`kind: grant`, payload `{type:"oauth", access, refresh, expires, accountId}`)
— exactly what the built-in flow would have written.

**Why start and status are separate**: `authorization.begin()` blocks until the human
finishes authorizing, and a device code is valid for ~15 minutes. One request/response call
would time out.

**Why device code by default**: the browser path binds **:1455**, which the Codex CLI also
uses and which is frequently already taken. Device code needs no listener.

## The guard: the provider cannot stay without a sign-in

`dsh-settings` emits `settings/updated` **after** a write and has no before-write hook
(verified on 0.2.2-rc.1), so a plugin cannot refuse the save. What it can do is undo it:

```
Settings → Models → add "openai-codex"   →  saved
                                         →  settings/updated fires
                                         →  no credential for llm-pi-ai/openai-codex
                                         →  unset providers.openai-codex, log why
```

The provider does not survive in the list, so the practical effect is the same as refusing it.

Without this, you can save a provider that **can never work**: it is OAuth-only, the Models page
only offers an API key field, the model catalog stays empty, and the first request fails with
`Provider is not configured`.

Turn it off with `guard: false` if you would rather have the provider sit there unconfigured.

## Install

```bash
# 1. put this directory anywhere, e.g. D:\dsh-plugins\dsh-codex-login
# 2. in your profile's package.json:
#      dependencies:        "dsh-codex-login": "link:D:/dsh-plugins/dsh-codex-login"
#      dsh.profile.bundles: [ ..., "dsh-codex-login" ]
# 3. create a junction in <profile>/node_modules pointing at this directory
#      Windows: New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-codex-login" -Target "D:\dsh-plugins\dsh-codex-login"
#      (do NOT use ln -sfn: under MSYS it creates a directory copy, not a link)
# 4. turn it on in the profile overlay
#      - id: codex-login
#        config:
#          enabled: true
# 5. restart dsh
```

`cordis.patch.yml` ships `enabled: false`, so nothing happens until step 4.

## Use

```bash
curl -X POST http://127.0.0.1:<port>/codex-login/start
```

```json
{ "ok": true, "phase": "pending", "code": "ABCD-12345",
  "url": "https://auth.openai.com/codex/device", "providerKey": "llm-pi-ai/openai-codex" }
```

Open the URL, enter the code, then:

```bash
curl http://127.0.0.1:<port>/codex-login/status
```

`phase: "authorized"` means the record is written. **Restart dsh**, then Settings → Models →
`openai-codex` → *Get available models*.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch |
| `providerKey` | `llm-pi-ai/openai-codex` | Credential record to authorize (`<scope>/<provider>` as `dsh-llm-pi-ai` builds it) |
| `method` | `oauth` | Flow method id — `dsh-llm-pi-ai` registers only `oauth` |
| `guard` | `true` | Undo the provider when no credential exists (see above) |
| `settingsNamespace` | `llm-pi-ai` | Cordis entry id holding the provider config |

Unknown keys are dropped rather than rejected, so a config written for a newer version still
loads on an older one.

## Requirements

- **A ChatGPT subscription** (Plus / Pro / Business). `chatgpt.com/backend-api` uses subscription
  quota — API credit does not apply here.
- Network reachable to `auth.openai.com`. Behind a proxy, make sure it carries **CONNECT** to
  that host; a flaky proxy shows up as `ECONNRESET` mid-poll.
- `dsh-llm-pi-ai` mounted with `openai-codex` in its catalog. Without it there is no flow to
  begin, and `/start` says so explicitly.

## Tests

```bash
node test/selftest.mjs
```

Covers: default off, every config key validated (unknown keys dropped), no routes registered
while off, missing `authorization` fails loudly with the service named, a missing flow points at
`dsh-llm-pi-ai`, `start` returns `pending` without blocking, the device code lands on state, a
second `start` does not spawn a second attempt, and the guard unsets a credential-less provider
while leaving it alone when a credential exists or the namespace is someone else's.

Reverse experiment: removing the `unset` call makes the guard test red.

The real sign-in path was verified by hand up to the device code being issued
(`https://auth.openai.com/codex/device` + an 8-character code). The polling stage could not be
verified end-to-end on the development machine because its proxy dropped the connection — that is
a network condition, not a code path.

## License

MIT
