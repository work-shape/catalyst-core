import client from "./client";

const applied = await client.migrate();
console.log(applied.length > 0 ? `Applied ${applied.join(", ")}.` : "The database is up to date.");
