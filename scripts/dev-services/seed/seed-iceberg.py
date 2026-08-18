import time
from datetime import datetime

import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import NamespaceAlreadyExistsError, NoSuchTableError
from pyiceberg.io.pyarrow import schema_to_pyarrow
from pyiceberg.schema import Schema
from pyiceberg.types import DoubleType, LongType, NestedField, StringType, TimestamptzType


FIXTURE_VERSION = 'events-v1'
FIXTURE_VERSION_PROPERTY = 'marimohub.fixture-version'
FIXTURE_SCHEMA = Schema(
    NestedField(1, 'id', LongType(), required=True),
    NestedField(2, 'ts', TimestamptzType()),
    NestedField(3, 'name', StringType()),
    NestedField(4, 'value', DoubleType()),
)
FIXTURE_ROWS = [
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
]


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
    table = None

if table is not None:
    fixture_matches = (
        table.properties.get(FIXTURE_VERSION_PROPERTY) == FIXTURE_VERSION
        and table.schema() == FIXTURE_SCHEMA
    )
    if fixture_matches:
        rows = sorted(table.scan().to_arrow().to_pylist(), key=lambda row: row['id'])
        fixture_matches = rows == FIXTURE_ROWS
    if not fixture_matches:
        catalog.drop_table('demo.events')
        table = None

if table is None:
    table = catalog.create_table(
        'demo.events',
        FIXTURE_SCHEMA,
        properties={FIXTURE_VERSION_PROPERTY: FIXTURE_VERSION},
    )

if table.current_snapshot() is None:
    table.append(
        pa.Table.from_pylist(
            FIXTURE_ROWS,
            schema=schema_to_pyarrow(table.schema()),
        ),
    )
