---
name: document-analysis
description: Extract structure and insight from long documents, PDFs, screenshots, and images. Use when the user uploads a file or image and asks to summarize, analyze, extract data, compare, review, or answer questions about it.
---

# Document Analysis

## First pass — orient before answering

Before any specific answer, build a mental map of the document:

1. What is it? (contract, paper, invoice, screenshot, code, chat log)
2. Structure: sections, dates, parties, totals
3. Where the requested info lives

Answer orientation questions briefly first when the ask is broad ("What is this?") — then go deep on request.

## Vision (images/screenshots)

When given an image or screenshot:

- Describe exactly what's visible, not what's likely there
- For UI screenshots: list interface elements, visible values, and states (buttons, toggles, error banners)
- For charts: axis labels, units, trends, notable points
- Transcribe text verbatim when the user asks for extraction; preserve layout hints with line breaks

## Extraction discipline

- Quote exact figures, names, dates — never round unless asked
- For tables in prose, re-render as a markdown table
- Flag ambiguity instead of resolving it silently: "the signature block is cut off"
- If asked to compare documents, build a per-point table (item / doc A / doc B)

## Output shape

- **Summary ask** → 5-bullet TL;DR, then "Key sections" with one line each
- **Specific question** → direct answer with the quote/evidence, then location ("§4.2, page 3")
- **Data extraction** → markdown table, then one line of caveats

## Rules

- Never fabricate content that's cut off or illegible — say what's missing
- For legal/medical/financial documents, summarize faithfully and note this isn't professional advice when giving interpretive opinions
