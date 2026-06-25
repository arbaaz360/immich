FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN pip install --no-cache-dir "psycopg[binary]==3.2.9"

COPY reverse_face_search.py /app/reverse_face_search.py

EXPOSE 2299

CMD ["python", "/app/reverse_face_search.py", "--host", "0.0.0.0", "--port", "2299"]
