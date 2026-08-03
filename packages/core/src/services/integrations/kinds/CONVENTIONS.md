# Integration kind conventions

Use these rules for each new integration kind.

## Configuration schemas

- Use `z.strictObject` for all fixed-shape objects. A misspelled field must cause a validation error.
- Use a record only when the keys are user-defined and the values are not secret.
- Use an array of `{ name, value }` objects for user-defined secret values.
- Add `x-unique-by: name` metadata to each named array. Add a Zod refinement that rejects duplicate names.
- Use `zSecret()` for each secret value. Do not add constraints to a secret value.
- Use a discriminated union for a field that can gain branch-specific fields.
- Add a description when the same field name has different meanings in different kinds.

## Names

- Use `host` for a hostname without a scheme, port, path, or credentials.
- Use `url` for a complete URL. Keep an existing vendor property name when the renderer passes it through unchanged.
- Use `username` for authentication. Use `user` only when the value is a query identity that differs from authentication.
- Use `auth` for an authentication union.
- Use `credentials` only for a provider credential chain that is not an authentication protocol.
- Use `warehouse` only when the vendor API uses that property name. Describe whether it is compute or storage.

## Rendering and metadata

- Validate protocol boundaries in the renderer. Do not depend only on the JSON Schema pattern.
- List process-wide environment variables in `environmentVariables`.
- Use `resolveRequirements` when the selected configuration changes the package set.
- Add one migration description for each increase of `schemaVersion`.
- Keep secret values out of descriptors, errors, and manifest metadata.
