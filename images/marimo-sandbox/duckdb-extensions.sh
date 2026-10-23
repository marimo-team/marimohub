# A persistent home can hide baked extensions. Login shells restore links to the
# image cache, including .info metadata needed by offline INSTALL statements.
src=/opt/marimohub/duckdb-extensions
if [ -d "$src" ] && [ -n "${HOME:-}" ]; then
    for f in "$src"/*/*/*; do
        [ -e "$f" ] || continue
        dst="$HOME/.duckdb/extensions/${f#"$src"/}"
        [ -e "$dst" ] && continue
        mkdir -p "$(dirname "$dst")" 2>/dev/null && ln -sfn "$f" "$dst" 2>/dev/null || true
    done
    unset f dst
fi
unset src
