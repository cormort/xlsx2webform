FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 7860

# Trust X-Forwarded-For from the platform proxy (HF Spaces / Railway) so rate limits
# key on the real client IP. Only safe when the container is reachable solely via that proxy.
ENV FORWARDED_ALLOW_IPS="*"

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860"]
