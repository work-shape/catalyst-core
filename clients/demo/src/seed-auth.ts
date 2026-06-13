import client from "./client";

const result = await client.seedStandaloneAuth();
console.log(`Seeded ${result.seededUserCount} standalone auth user(s).`);
