---
description: Import notebooks from a folder with their Python modules, data, and configuration files.
---

# Import notebooks from a folder

You need permission to create notebooks in the destination project.
Each imported notebook gets an independent copy of the included files. Edits in one copy do not change the others.

## Choose notebooks and files

1. Open a project and select **Import notebooks**.
2. Choose the common parent folder of your notebooks, Python modules, and data.
3. Select the notebooks to create and edit their names.
4. Expand **Included files** to review supporting files and exclusions.
5. Select **Import _N_ notebooks** to start the upload.

Likely marimo notebooks are selected automatically. Other `.py`, `.md`, `.markdown`, and `.qmd` files are available for manual selection.
Unchecking a notebook keeps its file available to the other notebooks.
To remove a supporting file, uncheck it in **Included files**. To remove several, filter the list and select **Exclude matching**.
Credential-like notebook files stay unselected by **Select matching**. Check each one to import it.

The import preserves file contents and paths relative to the selected folder.
That folder becomes the working directory. Nested notebooks can import modules from their own directory and the selected folder.
Include `pyproject.toml` and lockfiles when your notebooks need them.

Caches, Git metadata, and virtual environments stay excluded. A directory that contains `pyvenv.cfg` (such as `venv/` or `env/`) or is named `site-packages` is excluded with everything in it. A filename-based filter excludes common credentials such as `.env`, `id_rsa`, and `.pem` files by default.
The filter does not inspect file contents or detect every secret. Review **Included files** and exclude other sensitive files, including keys named `ssh_identity`.
Empty directories are not uploaded. The limits are 1,000 workspace files, 25 MiB per file, and 100 MiB total.
Without a root `pyproject.toml`, the hub adds an empty one. This leaves room for 999 included files.
Each file path is limited to 896 UTF-8 bytes, relative to the selected folder. Each folder or file name is limited to 255 UTF-8 bytes.

On a Cloudflare Workers deployment, the hub holds the whole upload in memory. An upload near 100 MiB can exceed the Worker memory limit. Import smaller folders there.

## Finish or recover

Keep the page open until the import finishes. Each notebook becomes available only after all its included files are stored.

| Result           | Next action                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Upload failed    | Correct the error and retry. Your selections remain in the review.                                   |
| Failed           | Select **Retry remaining** when available. Otherwise, review the error before starting a new import. |
| Outcome unknown  | Select **Check outcomes and retry**. The hub checks the existing attempt before it creates anything. |
| Still processing | Wait, then check again.                                                                              |
| Import stopped   | Select **Resume import** to continue the queue.                                                      |
| Expired          | Close the dialog and start a new import. Select only the notebooks that remain unfinished.           |

**Stop import** prevents new requests and lets the current request finish. It keeps imported notebooks. During the upload, **Stop import** cancels the upload and returns to the review.
Closing or reloading the page ends the browser queue. Reopening the dialog starts a new import.
If unfinished notebooks remain, closing the dialog asks **Leave unfinished import?**. Select **Leave import** to close it. Imported notebooks remain available.
The uploaded folder is available for retries for 24 hours. The dialog shows when the upload expires.
The hub keeps the record of each notebook's outcome for 7 more days, then deletes the import.

Folder import creates editable local notebooks. For notebooks connected to Git, use the existing [sync workflow](./syncing.md).

## API

The import uses three routes. All of them require permission to create notebooks in the project. Only the user who uploaded the folder can read or use an import.

| Route                                                                | Result                                                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/projects/{pid}/notebook-imports`                       | Upload the folder as a ZIP with `Content-Type: application/zip`. Returns `id`, `expires_at`, and the stored `files`.                                            |
| `POST /api/v1/projects/{pid}/notebook-imports/{import_id}/notebooks` | Create one notebook from `entry_notebook` with a `title` and optional `base_image` and `compute_profile`. A retry with the same body returns the same notebook. |
| `GET /api/v1/projects/{pid}/notebook-imports/{import_id}`            | Returns the state of each notebook that has an attempt: `preparing`, `publishing`, `complete` (with the notebook), or `expired`.                                |

A notebook that is absent from the `GET` result was not attempted, or its attempt stopped and you can retry it.
`expired` and a `409 IMPORT_RESTART_REQUIRED` response mean that you must upload the folder again.
The CLI does not include these routes.
