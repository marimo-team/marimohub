// Unpacked beside the server bundle and required by absolute path, so this is
// an ordinary on-disk module: its `import()` goes through the normal ESM loader
// rather than the SEA loader's builtin-only resolution. See launcher.cjs.
module.exports = (href) => import(href);
