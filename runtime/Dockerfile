FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends r-base-core r-base-dev \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /opt/aira/requirements.txt
RUN pip install --no-cache-dir -r /opt/aira/requirements.txt
COPY worker.py protocol.py typed_bridge.py /opt/aira/
ENV HOME=/tmp MPLCONFIGDIR=/tmp/matplotlib IPYTHONDIR=/tmp/ipython PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/aira
WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["python", "-u", "/opt/aira/worker.py"]
