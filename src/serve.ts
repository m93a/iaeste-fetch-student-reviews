import { getDataDump, AllReviewData } from "./scraper.ts";
const PORT = 6969;

// initialize fetching current data
let data: AllReviewData | undefined;
const fetchData = async () => {
  console.log("Started fetching fresh data!");
  data = await getDataDump();
  console.log("Fetched fresh data!");
};
fetchData();

// schedule fetching every 12 hours
const sec = 1_000;
const min = 60 * sec;
const hour = 60 * min;
setInterval(fetchData, 12 * hour);

// start the server
console.log(`Listening on port ${PORT}`);
const server = Deno.listen({ port: PORT });
for await (const conn of server) serve(conn);

async function serve(conn: Deno.Conn) {
  const httpConn = Deno.serveHttp(conn);

  for await (const ev of httpConn) {
    if (!data) {
      respond(ev, 500, { error: "The server has not fetched the data yet, try again in a minute or two." });
    } else {
      respond(ev, 200, data);
    }
  }
}

function respond(event: Deno.RequestEvent, status: number, payload: any) {
  event.respondWith(new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }));
}
