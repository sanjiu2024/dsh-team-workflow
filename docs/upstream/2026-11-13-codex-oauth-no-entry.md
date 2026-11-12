# OAuth-only providers have no sign-in entry point: `authorization.list()` has no consumer

**Version:** `@deepseek-ai/dsh` 0.2.2-rc.1 (desktop, Windows)

## Summary

`openai-codex` is an OAuth-only provider shipped in the pi-ai catalog (`env: []` — there is no
API key to enter). `dsh-llm-pi-ai` correctly registers an authorization flow for it. But **no UI
consumes `authorization.list()`**, so a user opening `openai-codex` in Settings → Models sees only
"API address" and "model catalog" — with no way to sign in. The provider is therefore unreachable
from the GUI.

## Evidence

**1. The provider is OAuth-only**

`@earendil-works/pi-ai/dist/index.js`:

```js
"openai-codex": {
  env: [],                                       // no API key by design
  defaultBaseURL: "https://chatgpt.com/backend-api"
}
```

The OAuth implementation is complete — `dist/auth/oauth/openai-codex.js` ships
`loginOpenAICodex` (browser callback on :1455), `loginOpenAICodexDeviceCode`, and
`refreshOpenAICodexToken`.

**2. dsh registers the flow unconditionally**

`@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2604-2620` — `registerPiAiFlows()`, whose own doc
comment states:

> Registration is unconditional on configuration: a provider has to be signed into before a
> route for it is worth adding, so the flow exists from the moment the plugin mounts rather than
> appearing once a profile does.

```js
ctx.authorization.registerFlow({
  key: recordKeyFor(providerId),        // "llm-pi-ai/openai-codex"
  label: provider.name,
  methods: [first, ...rest],
  async run(session) { await models.login(providerId, type, {...}) }
});
```

`@deepseek-ai/dsh-authorization/lib/index.js:18` even uses this exact case as its documentation
example:

```ts
const dispose = ctx.authorization.registerFlow({
  key: credentialKey('llm-pi-ai', 'openai-codex'),
  label: 'ChatGPT (Codex)',
  methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
  ...
})
```

**3. Nothing consumes it**

- `authorization.list()` (`dsh-authorization/lib/index.js:91`) — **zero call sites** in the
  installed tree.
- `dsh-client-ui-settings-models/lib/client.js` — the string `authorization` appears **0 times**.
  The page only handles API keys and a model catalog.
- `dsh-client-ui-settings-account` does reference `authorization`, but it is the **DeepSeek
  account onboarding step** (`step: done` after completion), not a provider sign-in surface.

## Impact

A user who has a ChatGPT Plus/Pro/Business subscription — the whole point of the `openai-codex`
provider — cannot use it at all. There is no API key to paste, and the "get available models"
button returns nothing because the request has no credentials. The model selector then shows
"no models will be displayed" (which is accurate, but the cause is unreachable from the UI).

## Suggested fix

Render `authorization.list()` somewhere in Settings → Models, one "Sign in" button per flow that
the current provider has. Minimal shape:

```
Provider: openai-codex        [ Sign in with ChatGPT ]
  → device code / browser callback handled by authorization.begin({ key, method, signal, interaction })
  → on success the record lands in credentials and the model catalog can be fetched
```

`authorization.begin()` is already a complete public API (`key`, `method`, `signal`, `interaction`
with `notify` / `prompt`). The only missing piece is a surface calling it.

Two smaller observations while wiring this up by hand:

- `begin()` blocks until the human finishes authorizing (device codes are valid for ~15 minutes),
  so a request/response surface needs a "start" then "poll status" split rather than one call.
- `openai-codex` defaults to the browser callback on **:1455**, which is shared with the Codex CLI
  and frequently taken. The device-code path avoids that entirely and would be a better default
  for a GUI.

## Workaround (for anyone hitting this today)

Call `authorization.begin()` from a small host plugin and pass a `interaction` that prints the
device code. That writes `llm-pi-ai/openai-codex` into `~/.dsh/.credentials.yaml` exactly as the
built-in flow would; after a restart the model catalog resolves. No core changes required — which
is also why I believe this is a UI gap rather than an API gap.
