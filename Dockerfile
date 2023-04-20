FROM denoland/deno:distroless-1.32.5

COPY . .

ENV PORT=6969
EXPOSE 6969

CMD ["run", "--allow-net", "--allow-env", "./src/serve.ts"]
