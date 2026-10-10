import { createApp } from "./bootstrap";

async function main(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API listening on port ${port}`);
}

void main();
