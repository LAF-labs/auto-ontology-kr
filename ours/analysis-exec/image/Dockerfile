# Analysis execution image for @ours/analysis-exec.
#
# Holds Python and the analysis libraries only. A run supplies everything else
# through mounts (/code and /input read-only, /output writable) and gets no
# network, a read-only root filesystem and a non-root user from the runner
# (src/docker-args.js); nothing in this image relaxes those.
#
#   docker build -t ours-analysis-exec:0.1 image/
FROM python:3.12-slim

# joblib runs serially: a run has one CPU and no shared memory (--ipc none).
# A Korean-capable font so figure labels in Korean render; no other system packages.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-nanum \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /opt/analysis/requirements.txt
RUN pip install --no-cache-dir --no-compile -r /opt/analysis/requirements.txt \
 && pip freeze > /opt/analysis/requirements.lock

COPY matplotlibrc /opt/analysis/matplotlibrc
COPY entry.py /opt/analysis/entry.py

RUN groupadd --gid 10001 analysis \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin analysis \
 && mkdir /code /input /output \
 && python -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.font_manager"

ENV MATPLOTLIBRC=/opt/analysis/matplotlibrc \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/mpl \
    HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    JOBLIB_MULTIPROCESSING=0

USER 10001:10001
WORKDIR /output
ENTRYPOINT ["python", "-B", "/opt/analysis/entry.py"]
