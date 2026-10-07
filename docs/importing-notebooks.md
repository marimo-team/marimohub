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
5. Select **Import notebooks** to start the upload.

Likely marimo notebooks are selected automatically. Other `.py`, `.md`, `.markdown`, and `.qmd` files are available for manual selection.
Unchecking a notebook keeps its file available to the other notebooks.
To remove a supporting file, uncheck it in **Included files**.

The import preserves file contents and paths relative to the selected folder.
That folder becomes the working directory. Nested notebooks can import modules from their own directory and the selected folder.
Include `pyproject.toml` and lockfiles when your notebooks need them.

Caches and Git metadata stay excluded. Files such as `.env` and private keys are excluded by default but remain visible for review.
Empty directories are not uploaded. The limits are 1,000 workspace files, 25 MiB per file, and 100 MiB total.
Without a root `pyproject.toml`, the hub adds an empty one. This leaves room for 999 included files.

## Finish or recover

Keep the page open until the import finishes. Each notebook becomes available only after all its included files are stored.

| Result                | Next action                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Upload failed         | Correct the error and retry. Your selections remain in the review.                                   |
| Some notebooks failed | Select **Retry remaining**. Successful notebooks stay available.                                     |
| Outcome unknown       | Select **Check outcomes and retry**. The hub checks the existing attempt before it creates anything. |
| Still processing      | Wait, then check again.                                                                              |
| Import stopped        | Select **Resume import** to continue the queue.                                                      |
| Upload expired        | Close the dialog and start a new import. Select only the notebooks that remain unfinished.           |

**Stop import** prevents new requests and lets the current request finish. It keeps imported notebooks.
Closing or reloading the page ends the browser queue. Reopening the dialog starts a new import.
The uploaded folder is available for retries for 24 hours.

Folder import creates editable local notebooks. For notebooks connected to Git, use the existing [sync workflow](./syncing.md).
