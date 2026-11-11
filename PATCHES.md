# Product fork patches

Base: upstream tag `dsh-v0.2.2-rc.1`. The installed app's build commit is not public; every package README in the app matches this tag byte for byte, while upstream `master` at fork time differed in 65. Name upstream revisions by tag here: the `verify-repository-references` gate rejects commit identifiers in maintained files.

Own code lives in top-level `ours/*` as profile bundles, outside `packages/`: the upstream build and gates glob `packages/*/*/package.json` (root `tsdown.config.ts`, `scripts/*`), so a package under `packages/ours/` breaks `pnpm run build`. `ours/` is not a pnpm workspace member and is installed into a profile with `dsh plugin --profile <name> add link:<dir>`.

Changes to upstream files:

| File | Change | Why |
| --- | --- | --- |
| `.gitignore` | `.dsh-dev/`, `.tools/`, `secrets/`, `*.key` | local dev home, local toolchain, secrets |

## Opt-in switches for the product bundle

Five upstream behaviors can be switched from a profile bundle. Every new option defaults to the upstream behavior, so a profile that does not set it runs unchanged. Row ids below are the ones the shipped profiles use (`packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml`) or the product row in `ours/presets/cordis.patch.yml`. A patch keyed by row id replaces that row's whole `config`, so restate every key the row owns.

### 1. Hidden agent presets

- Files: `packages/preset/agent-preset/src/index.ts` (Config `hidden`), `packages/preset/agent-preset-registry/src/{definition,preset,types,index}.ts` (`PresetDefinition.hidden`, roster rows carry `hidden: true`), `packages/client/ui-agent-preset/src/client/{settings-store.ts,AgentPresetSeat.tsx,AgentPresetSection.tsx,index.ts}` (pickers skip `hidden` options; the header label and chip still resolve the name), READMEs of the three packages (en and zh), tests in `agent-preset-registry/tests/registry.spec.ts` and `ui-agent-preset/tests/{components,section,settings-store}.client.spec.ts*`, generated `docs/config-catalog{,.zh}.md` and `packages/extensions/tool-cordis/src/api-catalog.ts`.
- Config key: `hidden` on a `@deepseek-ai/dsh-agent-preset` row's `config`; default `false`.
- Why: `dashboard-editor` is opened by the dashboard edit flow through `session.create({ agentPreset: 'dashboard-editor' })` and must not be offered in the new-session picker or as the Settings default. The flag lives on the declaration, so the roster that every client reads already carries it; a client-side id list would need a second place to name product presets.
- Revert when: upstream gains an equivalent declaration flag or picker filter.

```yaml
# Inside the existing insert in ours/presets/cordis.patch.yml (the row restates its whole config):
- id: preset-dashboard-editor
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: dashboard-editor
    hidden: true
    # name, description, order, plugins unchanged
```

### 2. Composer attachments off

- Files: `packages/client/ui-conversation/src/{index.ts,submission-settings.ts}` (Host Config `attachments`), `packages/client/ui-conversation/src/client/{apply.ts,contract/slots.ts,skeleton/InputBar.tsx}` (File action availability, `addFiles` refusal, `fileAttachments` composer hook, picker, paste and drop intake, attachment rail and drop overlay), `packages/client/ui-conversation/README{,.zh}.md`, tests `ui-conversation/tests/{apply-inject,input-bar,config.host,submission-policy,input-matrix,input-scenarios,skeleton}.client.spec.ts*`.
- Config key: `attachments` on the `ui-conversation` row; default `true`. It is a volatile field because the browser receives Host row values only through the `ui-conversation` settings namespace; the row keeps `settings.configure({ auto: false })`, so no Settings control appears.
- Why: the product accepts data only through Auto-ontology; files and images must not enter a conversation. Turning off the `ui-file-drag` row is not an option because `ui-chat` waits for its `fileDrag` service.
- Behavior: the `+` button still opens the command menu, which no longer lists File.
- Revert when: upstream gains a deployment switch for composer attachments.

```yaml
- id: ui-conversation
  config:
    attachments: false
```

### 3. Working-directory context off

- Files: `packages/session/working-directory/src/index.ts` (Config `modelContext`), `packages/session/working-directory/README{,.zh}.md`, `docs/subsystems/working-directory{,.zh}.md`, `packages/session/working-directory/tests/working-directory.spec.ts`, generated `docs/config-catalog{,.zh}.md`.
- Config key: `modelContext` on the `working-directory` row (base bundle); default `true`. `false` registers no `working-directory:current` context and queues no change notices; directory validation at prompt assembly and `working-directory/change` recording remain.
- Why: product presets have no file or shell tools, and the host path in every request led the model to link names to working-directory paths. The row cannot be turned off, because other services inject `workingDirectory`. The switch is per row, not per preset: the service and its context are Host-wide, and every product preset lacks file tools.
- Revert when: upstream lets a preset or row omit the required directory context.

```yaml
- id: working-directory
  config:
    modelContext: false
```

### 4. File and image link guidance off

- Files: none. The `ui:deliverable-file-references` section (the "Use ![Description](<path/to/image.png>) ... link every mention of an existing file" paragraph) is the only effect of the `@deepseek-ai/dsh-deliverable-file-references` row, its README already documents turning the row off, and its existing test checks that unloading the plugin removes the section. Nothing injects this plugin. The section is registered Host-wide, so the switch is per row. The separate `context:file-reference` section of `file-reference-local` renders only when the agent has the `read` tool, which no product preset mounts.
- Config key: the row's `disabled`; default enabled.
- Why: the guidance tells the model to link file mentions to working-directory paths, which product answers about analyses must not do.
- Revert when: not a code patch; drop the bundle row if the product later wants the guidance.

```yaml
- id: deliverable-file-references
  disabled: true
```

### 5. Browser sign-in instead of the launch token

- Files: `packages/client/connection/src/index.ts` (Config `signInPath`, passed to `BrowserAuth.create`), `packages/client/connection/src/browser-auth.ts` (`signInPath` branch in `authorizeIndex`, `authorizeConnect` and `authenticatedUrl`; new `issueSession` and `expireSession`), `packages/client/connection/src/rpc-host.ts` and `rpc.ts` (`ctx.connection.signIn(request)` and `signOut(request)` on `HostConnectionHandle`), `packages/client/connection/README{,.zh}.md`, test `packages/client/connection/tests/browser-sign-in.host.spec.ts`, generated `docs/config-catalog{,.zh}.md`.
- Config key: `signInPath` on the `connection` row (web-app bundle); an absolute path such as `/login`; default unset. Unset keeps the launch-token exchange unchanged.
- Behavior when set: the launch token is accepted nowhere (`/?token=` and `/connect` both refuse it) and `authenticatedUrl` returns the clean URL, so the startup line prints no token. An index request (`/`, `/index.html`) without a valid cookie gets `303` to `.<signInPath>` (relative, so a mount proxy's prefix is kept) instead of the plain `401`. `/api` and the WebSocket still answer `401`. A browser session starts only when a host plugin calls `ctx.connection.signIn(request)` and sends the returned `Set-Cookie`; `signOut(request)` returns the cookie that removes it. Both apply the Host/Origin checks and return `undefined` for a refused request. The cookie is the same signed, authority-bound, `HttpOnly`, `SameSite=Strict` value the token exchange mints; there is no session table.
- Why: customers sign in with a company account, and a per-process URL printed on a terminal cannot be handed to them. Cookie signing (`encodeCookie`) is internal to Connection, so a plugin cannot mint the cookie without either this switch or a copy of the format. `@ours/company-login` owns the page, the password check and the attempt limit.
- Limits kept from upstream: signing out clears the cookie in that browser only; a copied cookie stays valid until it expires (`cookieMaxAgeDays`) or the signing record is deleted. Every signed-in browser shares the one owner Peer.
- Revert when: upstream gains a sign-in hook or a public session-issuing method on Connection.

```yaml
# ours/company-login/cordis.patch.yml (the row restates its whole config):
- id: connection
  inject: [webStartup]
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts
    signInPath: /login
```

## Product shell packages with no core change

- `ours/locale-ko`: Korean through the locale service's language-pack API (`addLanguage`, per-locale `register`); default language through the `locale` row's `preference`.
- `ours/brand`: product name and logo through the `sidebar.brand.mark` and `sidebar.brand.name` slots and `webServer.tapIndex`. The window title is the `common` dictionary key `brand.localBuild` (`packages/client/ui-layout/src/client/AppFrame.tsx`); the client half replaces that entry in the loaded dictionaries, which reads the locale service's `dicts` map (declared `private` in TypeScript). If upstream changes that field, the title falls back to the upstream text; the alternative is the build-time `DSH_CLIENT_TITLE`.
