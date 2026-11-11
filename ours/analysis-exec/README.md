# @ours/analysis-exec

Python analysis for analyst Sessions, in a container that is separate from the harness host and has no network. The agent names verified saved analyses as inputs, writes a script, and shows one run as a result card that carries its evidence.

## Flow and tools

| Tool | Who acts | What it does |
| --- | --- | --- |
| `analysis_prepare_input` | host | Reads the analysis version from Auto-ontology, refuses anything not `verified`, fetches the whole result and writes `<name>.csv` (or `.parquet`) and `<name>.columns.json` into the Session's inputs. Arguments: a name, an analysis id, a version, parameter values, a cache age. No SQL and no file path. |
| `analysis_run_python` | model's code, in the container | Runs one script on the named inputs. Returns stdout, stderr, and the files written to `/output` (table previews, small JSON inline). Can be repeated; nothing it returns is shown as a finding. |
| `analysis_present_result` | host, with the model's claims | Turns one successful run into a result card. Inputs (analysis name, version, verified state, parameters, read time), code, run facts, numbers (`result.json`) and tables come from the host's record of the run. The model supplies the title, method, assumptions and uncertainty. `kind: forecast` is refused without an interval that names a CSV of the run and its lower and upper columns. |

The split follows where trust changes: data enters only through the first tool, model code runs only in the second, and the third binds what the person sees to what the host recorded.

## Isolation and limits

Every run is `docker run` with the arguments in [src/docker-args.js](src/docker-args.js):

- a new container per run, removed on exit, never pulled (`--rm --pull never`)
- `--network none`
- `--user 10001:10001`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--ipc none`
- `--read-only` root; `/tmp` is a 64 MiB in-memory filesystem (`noexec`)
- `/code` (the script) and `/input` (this run's inputs, hard links) are read-only bind mounts; `/output` is the only writable mount
- no environment from the host, no token, no log driver

| Limit (row config key) | Default | Enforced by |
| --- | --- | --- |
| `cpus` | 1 | `--cpus` |
| `memoryMb` | 1024 | `--memory`, no extra swap; exit 137 is reported as `killed` |
| `timeoutS` | 120 | host timer and `docker kill`; `timeout` inside the container 10 s later |
| `pidsLimit` | 128 | `--pids-limit` |
| `maxFileBytes` | 16 MiB | `--ulimit fsize` |
| `maxOutputBytes`, `maxOutputFiles` | 32 MiB, 64 | host measures `/output` every 500 ms and after the run; over the cap is `output_limit` and no artifact is returned |
| `maxStreamBytes` | 64 KiB each | host keeps the head and tail of stdout and stderr |
| `maxCodeBytes` | 64 KiB | refused before the run |
| `maxConcurrent`, `queueWaitS` | 2, 30 s | host semaphore; a run that gets no slot is `busy` |
| `maxInputsPerSession` | 16 | refused at prepare |
| `retentionDays` | 30 | run directories older than this are deleted at start and every six hours |

## Input sources

`inputSource` on the `analysis-exec` row (`ANALYSIS_EXEC_INPUT_SOURCE` in the shipped patch):

- `run` (default): `POST /api/saved-analyses/{id}/run` with the read token of `@ours/ao-connector`. A result cut by the version row limit is refused (`input_truncated`), because an input must be the whole result.
- `export`: the bulk export API (Auto-ontology `docs/saved-analyses.md` §15) with the token named by `exportKeyEnv` (role `analysis_exporter`). The host downloads the file through the gateway, checks its sha256 and keeps its own copy. Each prepare is one export against the daily quota.
- `auto`: `run`, and an export only when the run API cut the result.

The export token stays in the host process. A run never receives a token or the export directory.

## Files

```
index.js        host service ctx.analysisExec (row analysis-exec)
tools.js        agent tools (preset row @ours/analysis-exec/tools)
http.js         GET /api/analysis-exec/artifact?session=&run=&name= (figures inline, tables as download; owner cookie)
client.js       tool rows and the result card (rendered at the turn tail, below the closing reply)
image/          Dockerfile, requirements.txt, entry.py, matplotlibrc
src/            logic without harness imports: limits, docker-args, runner, inputs, runs, csv, tool-specs
tests/          node:test; tests/container needs docker and the image
```

Data lives under `dataDir` (`$DSH_HOME/analysis-exec`): `sessions/<session>/inputs`, `manifests`, and `runs/<run id>/{code,input,output,record.json,presentation.json}`.

## Build, install, test

```sh
docker build -t ours-analysis-exec:0.1 image/          # once per host; about 1 GB
pnpm dsh plugin --profile web add link:<abs>/harness/ours/analysis-exec
node --test tests/*.test.js                            # 35 tests, no container
ANALYSIS_EXEC_PROBE_PORTS=3110,3101 node --test tests/container/*.test.js   # 13 tests, real containers
```

Mount the tools in a preset next to the Auto-ontology tools:

```yaml
- id: analysis-exec-tools
  name: '@ours/analysis-exec/tools'
```

A host without the runtime or the image still boots; a run then answers `runtime_unavailable` or `image_missing`.

## Limitations

- The model can still type a number into its script instead of reading it from an input. The card shows the code, and the inputs it lists are the only data the run could read.
- `--ulimit fsize` and the 500 ms poll bound the output directory; a run can overshoot the total by what it writes between two polls before it is killed.
- On a Linux host the container user must be able to read the data directory and the host must be able to read what the run wrote; set `user` to an id that fits.
- Exit code 137 is reported as `killed` with a memory hint; the container is already removed, so the kernel's reason is not read back.
