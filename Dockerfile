ARG DENO_VERSION=2.9.1
FROM denoland/deno:${DENO_VERSION}

WORKDIR /app
USER deno

# Dependency layers cache before source: manifest and lockfile first.
COPY --chown=deno:deno deno.json deno.lock ./
RUN deno install --frozen

# Source and the bundled defaults that make the image standalone.
COPY --chown=deno:deno src/ ./src/
COPY --chown=deno:deno mappings/ ./mappings/
COPY --chown=deno:deno extensions/ ./extensions/
# The bundled extension surface is imported dynamically at startup, so it is
# cached as its own entrypoint alongside the static graph.
COPY --chown=deno:deno run.js ./
RUN deno cache run.js extensions/index.js

ENV PORT=3333
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["deno", "eval", "const port = Deno.env.get('PORT') || '3333'; const res = await fetch(`http://localhost:${port}/health/mapping`); if (!res.ok) Deno.exit(1)"]

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "run.js"]
