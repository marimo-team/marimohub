import os
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb
import pyarrow as pa
from pyiceberg.catalog import load_catalog

from bake_duckdb import BAKED_DIR, EXTENSIONS, install_extensions


assert os.getuid() != 0, "Extension checks must run as the sandbox user"

with duckdb.connect() as connection:
    install_extensions(connection)

    with TemporaryDirectory() as directory:
        catalog = load_catalog("offline", type="in-memory", warehouse=Path(directory).as_uri())
        catalog.create_namespace("test")
        rows = pa.table({"id": [1, 2, 3]})
        table = catalog.create_table("test.numbers", schema=rows.schema)
        table.append(rows)
        actual = connection.execute(
            "SELECT id FROM iceberg_scan(?) ORDER BY id", [table.metadata_location]
        ).fetchall()
        assert actual == [(1,), (2,), (3,)], actual

for root in (Path(BAKED_DIR), Path.home() / ".duckdb/extensions"):
    for name in EXTENSIONS:
        extensions = list(root.glob(f"*/*/{name}.duckdb_extension"))
        assert extensions, f"{name} missing from {root}"
        for extension in extensions:
            assert extension.with_suffix(".duckdb_extension.info").is_file(), extension

print(f"Offline extension checks passed: {', '.join(EXTENSIONS)}; Iceberg scan passed")
