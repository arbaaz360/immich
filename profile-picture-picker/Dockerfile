FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY profile_picture_picker ./profile_picture_picker

RUN pip install --no-cache-dir Pillow==12.2.0

EXPOSE 3111

CMD ["python", "-m", "profile_picture_picker.service"]
