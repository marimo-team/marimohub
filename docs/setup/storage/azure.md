<!-- Setup snippet — included by docs/storage.md and rendered in the deployment wizard. -->

Native Azure Blob Storage through the Azure SDK.

1. **Create a storage account and private container** for marimohub.
2. **Grant the server identity `Storage Blob Data Contributor`** on that container
   or its storage account.
3. **Set the container and Blob service URL:**

```bash
MARIMOHUB_STORAGE_BACKEND=azure
MARIMOHUB_STORAGE_AZURE_CONTAINER=orgname-marimohub
MARIMOHUB_STORAGE_AZURE_ACCOUNT_URL=https://account.blob.core.windows.net
```

The server uses `DefaultAzureCredential`, so managed identity, workload identity,
service-principal environment variables, and Azure developer credentials work
without additional marimohub secrets.

For Azurite, local development, or a legacy deployment, use a connection string
instead. It takes precedence over the account URL:

```bash
MARIMOHUB_STORAGE_BACKEND=azure
MARIMOHUB_STORAGE_AZURE_CONTAINER=orgname-marimohub
MARIMOHUB_STORAGE_AZURE_CONNECTION_STRING='…'  # secret
```

The container must already exist. On startup, marimohub verifies that ETag
conditions are enforced atomically and refuses to use a data-unsafe store.
