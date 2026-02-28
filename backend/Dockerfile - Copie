
# Use the official lightweight Python image.
# https://hub.docker.com/_/python
FROM python:3.11-slim

# Allow statements and log messages to immediately appear in the Knative logs
ENV PYTHONUNBUFFERED True

# Copy local code to the container image.
ENV APP_HOME /app
WORKDIR $APP_HOME
COPY . ./

# Install production dependencies.
RUN pip install --no-cache-dir -r requirements.txt

# Run the web service on container startup.
# We use uvicorn directly for simplicity with FastAPI, but for heavy load consider gunicorn with uvicorn workers.
# Cloud Run expects the app to listen on PORT environment variable.
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
