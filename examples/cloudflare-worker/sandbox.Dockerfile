FROM docker.io/cloudflare/sandbox:0.7.1

# Install claude-code
RUN npm install -g @anthropic-ai/claude-code

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Initialize a uv project and install marimo with extras
WORKDIR /workspace
RUN uv init --no-workspace --no-readme --python 3.13 && \
    uv add 'marimo[mcp,recommended,ai,lsp]' nbformat 'nbconvert[webpdf]'
RUN rm -f main.py

# Configure
RUN printf '\n[tool.marimo.runtime]\nwatcher_on_save = "autorun"\n' >> pyproject.toml

# Port 3000 is used by the sandbox SDK internally
EXPOSE 3000
