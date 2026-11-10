# Product fork patches

Base: upstream tag `dsh-v0.2.2-rc.1` (`66491b05`). The installed app's build commit `c59d10a` is not public; every package README in the app matches this tag byte for byte (master `fcc0ad4` differs in 65).

Own code lives in `packages/ours/*` as profile bundles. Changes to upstream files are listed here.

| File | Change | Why |
| --- | --- | --- |
| `pnpm-workspace.yaml` | `'!packages/ours/**'` excluded from workspace packages | `packages/ours/*` are installed into a profile with `dsh plugin add`; keeping them out of the workspace leaves the upstream lockfile and package gates unchanged |
| `.gitignore` | `.dsh-dev/`, `.tools/`, `secrets/`, `*.key` | local dev home, local toolchain, secrets |
