# DocTalk — RAG-Powered Document Chat

DocTalk is a retrieval-augmented generation (RAG) web application inspired by NotebookLM. You upload a **PDF or plain `.txt`** file through the browser, the backend **chunks and embeds** the content into **Qdrant Cloud**, then you **chat with the document**. Answers are generated with **gpt-4.1-mini** using only the retrieved context — not the model’s general knowledge.

---

## What it does

In one flow:

1. Upload `.pdf` or `.txt` (up to **20&nbsp;MB**) via Multer.
2. The server parses the file, splits it into overlapping chunks, embeds chunks with OpenAI **`text-embedding-3-large`**, and writes vectors to **one Qdrant collection per upload** (`doctalk-{uuid}`).
3. You ask questions in a minimalist web UI.
4. The server retrieves **top‑5** similar chunks from Qdrant, builds a labelled context string, and calls **`gpt-4.1-mini`** with a strict “context only” system prompt.
5. The UI shows the answer plus a **Sources** accordion with previews and **page numbers** when available.

---

## RAG Pipeline

1. **Ingestion** — `POST /api/upload` accepts `multipart/form-data` with field `document`. Multer saves the file under `./uploads/`, then `ingest()` loads it:
   - **PDF:** `@langchain/community` `PDFLoader` (fallback: **`pdf-parse`** if loading fails).
   - **TXT:** LangChain **`TextLoader`**.
2. **Chunking — `RecursiveCharacterTextSplitter`** (`chunkSize: 1000`, `chunkOverlap: 200`). Recursive splitting tries common delimiters (`\n\n`, `\n`, space) so passages stay coherent and sentences are less often cut mid-thought — better than naive fixed slices for readability and retrieval quality.
3. **Embedding** — OpenAI **`text-embedding-3-large`** (embedding size **3072** dimensions by default).
4. **Storage** — **`QdrantVectorStore.fromDocuments`** targeting **Qdrant Cloud** (`QDRANT_URL`, `QDRANT_API_KEY`). Each document session gets its own **`collectionName`** so data never collides.
5. **Retrieval** — **`QdrantVectorStore.fromExistingCollection`** + **`.asRetriever({ k: 5 }).invoke(question)`** (cosine similarity as configured in the underlying store).
6. **Generation** — OpenAI **SDK** (not LangChain) with model **`gpt-4.1-mini`**, `max_tokens: 1000`, `temperature: 0.2`, and the required system prompt that forces answers to stay **inside the provided context** and to **cite page/chunk** or use the exact fallback line when the context does not contain the answer.

---

## Tech Stack

| Package | Version (installed) |
|--------|----------------------|
| Node.js | 20+ |
| `express` | 4.22.1 |
| `multer` | 1.4.5-lts.2 |
| `dotenv` | 16.6.1 |
| `langchain` | 0.3.37 |
| `@langchain/community` | 0.3.59 |
| `@langchain/core` | 0.3.80 |
| `@langchain/openai` | 0.3.17 |
| `@langchain/qdrant` | 0.1.3 |
| `openai` | 4.104.0 |
| `pdf-parse` | 1.1.4 |

The repo includes a **`.npmrc`** with `legacy-peer-deps=true` so `npm install` succeeds with the LangChain peer graph (important for local dev and **Render** builds).

---

## Local Setup

1. **Clone** this repository.
2. Run **`npm install`** (uses `.npmrc` automatically).
3. Copy **`.env.example`** to **`.env`** and fill in real values (never commit `.env`).
4. **Qdrant Cloud (free tier)**  
   - Sign up at [https://cloud.qdrant.io](https://cloud.qdrant.io).  
   - Create a cluster; copy the **HTTPS cluster URL** as `QDRANT_URL`.  
   - Create an **API key** and set `QDRANT_API_KEY`.
5. **OpenAI** — Create an API key at [https://platform.openai.com](https://platform.openai.com) and set `OPENAI_API_KEY`.
6. Run **`npm run dev`** (or `npm start`).
7. Open **http://localhost:3000** (or the port in `PORT`).

The server creates `./uploads/` if missing and tracks active sessions in an **in-memory `Map`**. If the process restarts, you must **upload again** for a new session (the Qdrant collections may still exist on the cloud, but the app only chats for collections registered in the current process).

---

## Deployment

We split the deployment into two distinct pieces so you can maximize the Generous Free Tiers of the two top platforms:
1. **Backend (Render.com)** — Handles the Node API, doc uploading, and running OpenAI models.
2. **Frontend (Vercel)** — Hosts the HTML/JS static files.

### 1. Render.com (Backend)

1. Push this repo to your GitHub.
2. Sign in to [Render.com](https://render.com) and create a **Web Service** pointing to your repository.
3. Configure it as a **Node** environment, with Build Command `npm install` and Start Command `npm start`.
4. Add your Environment variables (`OPENAI_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY`).
5. Deploy it and copy the live URL (e.g., `https://doctalk.onrender.com`).

### 2. Connect the Vercel Proxy
Because Render is on a different domain, the frontend needs to know where the backend is. Open the `vercel.json` file in this repository and update the destination URL with the exact Render URL you just acquired. Save and push to GitHub.

### 3. Vercel (Frontend)

1. Sign in to [Vercel.com](https://vercel.com).
2. **Add New...** -> **Project** and select this repository.
3. Keep default settings (`Output Directory: public`) and deploy.
Vercel will act as a proxy.

> **Note:** The Render free tier spins down the backend after 15 minutes of inactivity. When a user first opens your Vercel site after a period of dormancy, the frontend displays a "Wake up call sent to Render backend..." banner while the server restarts (which takes ~50 seconds).

---

## Environment Variables

| Name | Required | Description |
|------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI secret key for embeddings and chat. |
| `QDRANT_URL` | Yes | Qdrant Cloud cluster URL (HTTPS). |
| `QDRANT_API_KEY` | Yes | Qdrant Cloud API key (**required for cloud** clusters). |
| `PORT` | No | HTTP port (defaults to **3000** locally; Render sets automatically). |

---

## Live Demo

[Live Demo →](LIVE_URL_HERE)

Replace `LIVE_URL_HERE` after your first Render deployment.

---

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness probe — `{ "status": "ok" }`. |
| `POST` | `/api/upload` | Multipart field **`document`** — ingest + index (returns `uploadId`, `collectionName`, `chunkCount`). |
| `POST` | `/api/chat` | JSON `{ collectionName, question }` — RAG answer + `sources`. |

---

## Project layout

```
doctalk/
├── public/index.html       # Frontend (single file)
├── src/
│   ├── pipeline/
│   │   ├── ingest.js
│   │   └── retrieval.js
│   └── server.js
├── uploads/                # Temporary Multer disk path (ignored by git)
├── .env.example
├── .npmrc
├── .gitignore
├── package.json
└── README.md
```

---

## License & coursework

Submitted as Assignment 03 — NotebookLM‑style RAG. Ensure **`LIVE_URL_HERE`** points to your deployed Render URL before grading.
