# Use the official lightweight Python image.
# https://hub.docker.com/_/python
FROM python:3.11-slim

# Prevent .pyc generation and unbuffered logs in Cloud Run / Knative
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV APP_HOME=/app

WORKDIR $APP_HOME

# Dedicated non-root runtime user
RUN groupadd --gid 10001 appuser \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin appuser

# Install pinned production dependencies first for layer caching
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend application owned by non-root user
COPY --chown=appuser:appuser . ./

USER appuser
EXPOSE 8080

# Cloud Run expects the app to listen on PORT environment variable
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
