import path from "node:path";
import { readFile } from "node:fs/promises";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { Document } from "@langchain/core/documents";
import { OpenAIEmbeddings } from "@langchain/openai";
import { QdrantVectorStore } from "@langchain/qdrant";

/**
 * Normalize page number for PDF loaders that expose it under different metadata keys.
 */
function normalizeDocuments(docs, sourceBasename) {
  return docs.map((doc) => {
    const loc = doc.metadata?.loc ?? {};
    const pageFromMeta =
      loc.pageNumber ??
      doc.metadata?.pdf?.pageNumber ??
      doc.metadata?.pageNumber ??
      doc.metadata?.page ??
      undefined;

    const nextLoc =
      pageFromMeta !== undefined
        ? { ...loc, pageNumber: pageFromMeta }
        : Object.keys(loc).length
          ? loc
          : { pageNumber: undefined };

    return new Document({
      pageContent: doc.pageContent,
      metadata: {
        ...doc.metadata,
        source: sourceBasename,
        loc: nextLoc,
      },
    });
  });
}

/**
 * Fallback when PDFLoader fails — uses pdf-parse to extract text then one Document.
 */
async function loadPdfViaPdfParseFallback(filePath, sourceBasename) {
  const pdfParse = (await import("pdf-parse")).default;
  const buffer = await readFile(filePath);
  const data = await pdfParse(buffer);

  const text =
    typeof data.text === "string" && data.text.trim().length > 0
      ? data.text
      : buffer.toString();

  return [
    new Document({
      pageContent: text,
      metadata: {
        source: sourceBasename,
        loc: { pageNumber: undefined },
      },
    }),
  ];
}

export async function ingest(filePath, mimeType, collectionName) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  if (!process.env.QDRANT_URL || !process.env.QDRANT_API_KEY) {
    throw new Error("QDRANT_URL and QDRANT_API_KEY must be set for Qdrant Cloud.");
  }

  const sourceBasename = path.basename(filePath);

  try {
    let docs;

    if (mimeType === "application/pdf") {
      try {
        const loader = new PDFLoader(filePath);
        docs = await loader.load();
        docs = normalizeDocuments(docs, sourceBasename);
      } catch (pdfLoaderErr) {
        console.warn("PDFLoader failed, falling back to pdf-parse:", pdfLoaderErr?.message ?? pdfLoaderErr);
        docs = await loadPdfViaPdfParseFallback(filePath, sourceBasename);
      }
    } else if (mimeType === "text/plain") {
      const loader = new TextLoader(filePath);
      docs = await loader.load();
      docs = normalizeDocuments(docs, sourceBasename);
    } else {
      throw new Error(`Unsupported MIME type for ingestion: ${mimeType}`);
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    const splitDocs = await splitter.splitDocuments(docs);

    const chunks = splitDocs.map(
      (doc, chunkIndex) =>
        new Document({
          pageContent: doc.pageContent,
          metadata: {
            ...doc.metadata,
            chunkIndex,
          },
        }),
    );

    if (chunks.length === 0) {
      throw new Error("Could not extract any text chunks from this file. Try a different document.");
    }

    console.log(`[ingest] Total chunks created: ${chunks.length}`);

    const embeddings = new OpenAIEmbeddings({
      model: "text-embedding-3-large",
    });

    await QdrantVectorStore.fromDocuments(chunks, embeddings, {
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
      collectionName,
    });

    return { chunkCount: chunks.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Ingestion failed: ${msg}`);
  }
}
