FROM python:3.13-slim

WORKDIR /seed

COPY requirements.txt ./
RUN pip install --disable-pip-version-check --no-cache-dir --no-deps -r requirements.txt

COPY seed-iceberg.py ./

CMD ["python", "/seed/seed-iceberg.py"]
