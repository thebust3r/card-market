// Card Market restock checker: a Cloudflare Worker that runs on a schedule
// (see the deploy workflow; every 5 minutes) and shares the site's database.
import {runRestock} from "../shared/restock.js";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRestock(env.DB));
  },
  async fetch() {
    return new Response("Card Market restock checker. Nothing to see here.", {status: 404});
  },
};
