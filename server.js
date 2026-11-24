import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

app.use(express.static(__dirname, { index: 'index.html' }));

app.listen(port, host, () => {
  console.log(`Ollama Code listening on http://${host}:${port}`);
});
