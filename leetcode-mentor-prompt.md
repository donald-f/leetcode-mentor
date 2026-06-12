# Prompt for Claude Code

Build a self-hosted "LeetCode Mentor" chat web app that I'll deploy on Railway. It uses the OpenAI API (I have a key). Keep it a single, lightweight service to minimize hosting cost.

## Stack
- One Node.js (Express) app serving both the API and a static frontend — single Railway service, no separate frontend deploy
- OpenAI official SDK; API key read from `OPENAI_API_KEY` env var (never exposed to the browser — all OpenAI calls go through the server)
- Streaming responses to the UI (SSE)
- No database for v1: persist conversations in browser localStorage, keyed per problem

## Core features
- Chat UI with markdown rendering and syntax highlighting (I'll paste problem statements and code). Code input should preserve formatting.
- A mode selector per conversation:
  1. **Socratic mentor (default)** — asks me to explain my approach first, responds with guiding questions, and never reveals the solution unless I explicitly ask for it
  2. **Hint ladder** — gives progressively stronger hints, one level at a time, only when I ask for the next hint
  3. **Full solution** — walks through the optimal solution step by step with time/space complexity, then asks me 1–2 follow-up questions to check understanding
- A **"review my solution"** action: critiques my submitted code for correctness, complexity, edge cases, and readability, and suggests the classic follow-up variations interviewers ask
- Conversation list sidebar (localStorage), "new problem" button, ability to rename/delete conversations
- Model selector with `gpt-4o-mini` as the cheap default and one stronger model option; show which model is active
- Simple access gate: require a password from an `APP_PASSWORD` env var (basic login screen + session cookie) so the deployed endpoint isn't publicly usable with my API key

## System prompt
Write a high-quality mentor system prompt baked into the server that:
- Defaults to Socratic behavior and adapts strictness based on the selected mode
- Always asks what I've tried / what my current thinking is before giving substantive help
- Frames hints in terms of patterns (two pointers, sliding window, DP, etc.) before specifics
- Supports a configurable preferred language list (default: C#, with JavaScript as secondary) via env var or settings

## Railway specifics
- Listen on `process.env.PORT`
- Keep the app stateless and fast to cold-start so it works well with Railway's app sleeping / scale-to-zero (I want it to sleep when idle to keep costs near zero)
- Include a Dockerfile or railway-compatible config as appropriate
- README covering: env vars (`OPENAI_API_KEY`, `APP_PASSWORD`), local dev steps, and Railway deploy steps

## Quality bar
- Clean, modern, dark-theme UI; mobile-friendly since I'll sometimes use it from my phone
- Graceful error handling for OpenAI rate limits / failures with a visible message in the chat
- Keep dependencies minimal
