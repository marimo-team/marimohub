"""Cache DuckDB extensions for offline use, including kernels with a mounted home."""

import duckdb

BAKED_DIR = "/opt/marimohub/duckdb-extensions"
EXTENSIONS = ("httpfs", "iceberg")


def install_extensions(connection: duckdb.DuckDBPyConnection) -> None:
    for extension in EXTENSIONS:
        connection.install_extension(extension)
        connection.load_extension(extension)
        # DuckDB 2 requires draining the result before the next extension operation.
        state = connection.execute(
            "SELECT installed, loaded FROM duckdb_extensions() "
            "WHERE extension_name = ?",
            [extension],
        ).fetchall()
        if state != [(True, True)]:
            raise RuntimeError(f"{extension} not installed and loaded: {state}")


def main() -> None:
    with duckdb.connect(config={"extension_directory": BAKED_DIR}) as connection:
        install_extensions(connection)


if __name__ == "__main__":
    main()
