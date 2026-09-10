FROM python:3.12-slim AS base
WORKDIR /app

FROM base AS builder
COPY requirements*.txt ./
RUN pip install --no-cache-dir --user -r requirements.txt

FROM base AS runner
COPY --from=builder /root/.local /root/.local
COPY . .
WORKDIR /app

ENV PATH=/root/.local/bin:$PATH
ENV PYTHONPATH=/app
EXPOSE 8000

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
