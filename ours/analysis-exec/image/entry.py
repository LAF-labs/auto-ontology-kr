"""Container entry point: runs /code/main.py as __main__ from /output.

Kept in the image so a run mounts only data and its own script. Prints the
traceback of a failing script to stderr and exits 1; the exit code and both
streams are what the host records.
"""
import os
import runpy
import sys
import traceback

SCRIPT = "/code/main.py"


def main() -> int:
    os.chdir("/output")
    sys.argv = [SCRIPT]
    try:
        runpy.run_path(SCRIPT, run_name="__main__")
    except SystemExit as exc:
        code = exc.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        print(code, file=sys.stderr)
        return 1
    except BaseException:  # noqa: BLE001 - report every failure of the user's script
        traceback.print_exc()
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
