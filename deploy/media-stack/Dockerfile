# Media Stack — single-repo multi-stage build for all three tiers.
# Build targets: gateway, media, h3
# Context: deploy/media-stack/

# ============================================================
# BASE: CUDA 13 + shared torch layer
# ============================================================
FROM nvidia/cuda:13.0.1-runtime-ubuntu22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TOKENIZERS_PARALLELISM=true

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3.10-venv python3-pip \
        ffmpeg wget unzip git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip3 install --upgrade pip && \
    pip3 install torch==2.11.0 torchvision==0.26.0 \
        --extra-index-url https://download.pytorch.org/whl/cu130

# Create per-tier venvs (with system-site-packages for the shared torch layer)
RUN python3.10 -m venv --system-site-packages /opt/venv-gw && \
    python3.10 -m venv --system-site-packages /opt/venv-media && \
    python3.10 -m venv --system-site-packages /opt/venv-h3

# ============================================================
# DEPS: install per-tier requirements
# ============================================================
FROM base AS deps

COPY requirements-gateway.txt requirements-media.txt requirements-h3.txt ./

RUN /opt/venv-gw/bin/pip install --upgrade pip && \
    /opt/venv-gw/bin/pip install -r requirements-gateway.txt

RUN /opt/venv-media/bin/pip install --upgrade pip && \
    /opt/venv-media/bin/pip install -r requirements-media.txt

RUN /opt/venv-h3/bin/pip install --upgrade pip && \
    /opt/venv-h3/bin/pip install -r requirements-h3.txt

# ============================================================
# GATEWAY target: CPU-only FastAPI proxy
# ============================================================
FROM deps AS gateway

COPY services/gateway.py /app/services/gateway.py

EXPOSE 8000
CMD ["/opt/venv-gw/bin/python", "-m", "uvicorn", "services.gateway:app", \
     "--host", "0.0.0.0", "--port", "8000", "--app-dir", "/app"]

# ============================================================
# MEDIA target: Chroma1-HD + WAN 2.2 I2V 14B Lightning
# ============================================================
FROM deps AS media

COPY services/media_service.py /app/services/media_service.py

ENV AOTI_MODE=eager \
    CHROMA_BF16=0

EXPOSE 8001
CMD ["/opt/venv-media/bin/python", "-m", "uvicorn", "services.media_service:app", \
     "--host", "0.0.0.0", "--port", "8001", "--app-dir", "/app"]

# ============================================================
# H3 target: Multi-service (conditioner or denoiser selected via SERVICE env)
# ============================================================
FROM deps AS h3

COPY services/h3_conditioner.py /app/services/h3_conditioner.py
COPY services/h3_denoiser.py /app/services/h3_denoiser.py

ENV H3_FP8=1 \
    H3_COMPILE=0

EXPOSE 8002 8003
CMD ["/opt/venv-h3/bin/python", "-c", "import os, sys; \
     svc = os.environ.get('SERVICE', 'h3-conditioner'); \
     mod = {'h3-conditioner': 'services.h3_conditioner:app', \
            'h3-denoiser': 'services.h3_denoiser:app'}.get(svc); \
     port = {'h3-conditioner': '8002', 'h3-denoiser': '8003'}.get(svc, '8002'); \
     sys.exit(os.system(f'/opt/venv-h3/bin/python -m uvicorn {mod} --host 0.0.0.0 --port {port} --app-dir /app'))"]
