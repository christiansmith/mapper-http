ARG DENO_VERSION=2.8.3
FROM denoland/deno:${DENO_VERSION}
WORKDIR /app

COPY --chown=deno:deno deno.json deno.lock run.js ./
COPY --chown=deno:deno src/ ./src/

RUN deno cache --reload run.js

ENV PORT=3333
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["deno", "eval", "--allow-net", "--allow-env", "const p=Deno.env.get('PORT') || '3333'; const r=await fetch(`http://localhost:${p}/health`); if(!r.ok) Deno.exit(1)"]

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "--import-map=/app/deno.json", "run.js"]