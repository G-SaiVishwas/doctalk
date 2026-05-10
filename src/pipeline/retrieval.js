import { OpenAI } from "openai";
import { OpenAIEmbeddings } from "@langchain/openai";
import { QdrantVectorStore } from "@langchain/qdrant";

export async function answer(collectionName, question) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  if (!process.env.QDRANT_URL || !process.env.QDRANT_API_KEY) {
    throw new Error("QDRANT_URL and QDRANT_API_KEY must be set for Qdrant Cloud.");
  }

  const embeddings = new OpenAIEmbeddings({
    model: "text-embedding-3-large",
  });

  let vectorStore;
  try {
    vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
      collectionName,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not\s*found|404|does\s*not\s*exist|Unknown collection/i.test(msg)) {
      throw new Error(
        "No indexed document found for this session. Upload a document first, or your server may have restarted (re-upload required).",
      );
    }
    throw new Error(`Could not connect to vector store: ${msg}`);
  }

  const retriever = vectorStore.asRetriever({ k: 5 });
  let retrievedDocs;
  try {
    retrievedDocs = await retriever.invoke(question);
    console.log(`[retrieval] Retrieved ${retrievedDocs.length} documents for question: "${question}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not\s*found|404|does\s*not\s*exist|Unknown collection/i.test(msg)) {
      throw new Error(
        "No indexed document found for this session. Upload a document first, or your server may have restarted (re-upload required).",
      );
    }
    throw new Error(`Retrieval failed: ${msg}`);
  }

  const contextString = retrievedDocs
    .map((doc) => {
      const idx = doc.metadata.chunkIndex ?? "?";
      const page = doc.metadata.loc?.pageNumber ?? "N/A";
      return `[Chunk ${idx} | Page ${page}]\n${doc.pageContent}`;
    })
    .join("\n\n---\n\n");

  const systemPrompt = `You are DocTalk, an AI assistant that answers questions based on the document context provided below.

Rules:
- ONLY use information from the provided context.
- If the user asks for a general summary, overview, or what the document is about, provide a summary of the context retrieved.
- If the answer to a specific factual question is completely missing from the context, respond exactly with: "I could not find an answer to that in the uploaded document."
- Always cite which chunk or page your answer comes from, e.g. (Page 3) or (Chunk 2).
- Do not use any external or prior knowledge.

DOCUMENT CONTEXT:
${contextString}
`
;

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1000,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";

  return {
    answer: text,
    sources: retrievedDocs.map((d) => ({
      pageContent: d.pageContent.slice(0, 200) + "...",
      pageNumber: d.metadata.loc?.pageNumber ?? null,
    })),
  };
}
