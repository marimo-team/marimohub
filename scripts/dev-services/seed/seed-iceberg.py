import time
from datetime import datetime

import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import NamespaceAlreadyExistsError, NoSuchTableError
from pyiceberg.io.pyarrow import schema_to_pyarrow
from pyiceberg.schema import Schema
from pyiceberg.types import DoubleType, LongType, NestedField, StringType, TimestamptzType


catalog = load_catalog(
    'seed',
    type='rest',
    uri='http://iceberg-rest:8181',
    warehouse='s3://warehouse',
    **{
        's3.endpoint': 'http://minio:9000',
        's3.access-key-id': 'minioadmin',
        's3.secret-access-key': 'minioadmin',
        's3.region': 'us-east-1',
        's3.force-virtual-addressing': 'false',
    },
)

for attempt in range(60):
    try:
        catalog.list_namespaces()
        break
    except Exception:
        if attempt == 59:
            raise
        time.sleep(1)

try:
    catalog.create_namespace('demo')
except NamespaceAlreadyExistsError:
    pass

try:
    table = catalog.load_table('demo.events')
except NoSuchTableError:
    table = catalog.create_table(
        'demo.events',
        Schema(
            NestedField(1, 'id', LongType(), required=True),
            NestedField(2, 'ts', TimestamptzType()),
            NestedField(3, 'name', StringType()),
            NestedField(4, 'value', DoubleType()),
        ),
    )

if table.current_snapshot() is None:
    table.append(
        pa.Table.from_pylist(
            [
                {
                    'id': 1,
                    'ts': datetime.fromisoformat('2026-08-01T09:15:00+00:00'),
                    'name': 'signup',
                    'value': 1.0,
                },
                {
                    'id': 2,
                    'ts': datetime.fromisoformat('2026-08-01T09:22:31+00:00'),
                    'name': 'page_view',
                    'value': 3.0,
                },
                {
                    'id': 3,
                    'ts': datetime.fromisoformat('2026-08-01T10:04:12+00:00'),
                    'name': 'purchase',
                    'value': 49.99,
                },
            ],
            schema=schema_to_pyarrow(table.schema()),
        ),
    )
