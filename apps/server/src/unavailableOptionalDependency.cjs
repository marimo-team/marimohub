// Bundled in place of optional native packages the server never ships
// (see the `alias` map in vite.config.ts). Callers require these inside a
// try/catch and fall back to pure JS; throwing here keeps that fallback while
// leaving no bare `require()` in the bundle that Node would otherwise resolve
// through every ancestor node_modules directory at runtime.
throw new Error('optional dependency is not bundled with the marimohub server');
