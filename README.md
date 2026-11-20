# Sus: the study game where one card is lying

**Live:** https://sus-study-game.web.app

Sus turns your study notes into a party game. AI pulls the key facts out of your notes and secretly writes **one believable lie** for each. Everyone at the table gets a card on their phone, and one player gets the lie without knowing it. You each explain your card in your own words, vote on who's sus, and the reveal shows exactly what the lie was and why the real fact is true.

Re-reading notes is one of the weakest ways to study. Explaining ideas out loud and catching mistakes work much better, but they're boring alone. Sus makes them something friends actually want to do before an exam.

Built for the **#BuildHybridAI 2026** hackathon with **Firebase AI Logic hybrid inference**.

---

## How a game works

1. **Host** (laptop): add notes by typing, pasting, uploading a **PDF**, or snapping a **photo** of handwritten notes, slides or a whiteboard. Then choose **🔒 Private** or **⚡ Fast** and click **Create room**.
2. **Players** scan the QR code or type the 4-letter room code on their phones. No app install or account is needed.
3. While friends join, the AI writes the cards in the background, so nobody waits.
4. **Each round**: everyone gets the real card except one random player, who gets the lie. Explain, vote, reveal.
5. **Scoring**: +1 for catching the liar. If nobody catches them, the liar gets +2.
6. **Final screen**: leaderboard, plus **"Revise these before your exam"**, a list of every fact the group got fooled by.

There's also a **solo practice** mode: pick the sus card in each pair.

## Hybrid AI: what runs where

| Task | 🔒 Private mode | ⚡ Fast mode |
|---|---|---|
| Pull key facts from notes | Gemini Nano **on the laptop** (`PREFER_ON_DEVICE`) | Cloud Gemini (`PREFER_IN_CLOUD`) |
| Write one lie per fact | On device | Cloud |
| Read a photo / scanned page | Gemini Nano multimodal, on device | Cloud |
| Read a PDF with a text layer | PDF.js **in the browser**, no AI or upload needed | Same |

- Every card shows a **🔒 device / ☁️ cloud** chip, so you can see where each one was made.
- If a device can't run Gemini Nano (phones, other browsers, older laptops), Private mode **falls back to the cloud automatically**. If the cloud is unreachable, Fast mode falls back to the device.
- **Exactly one lie per card, by construction.** The model doesn't write the sus card. It picks one phrase from the real fact and a believable replacement, and the app swaps them in code. Small on-device models can't sneak in a second mistake.
- **Long notes**: on-device prompts use an evenly spaced sample from across the whole document, not just the first page. The cloud gets up to ~30k characters.
- **Hiding latency**: on a laptop without a GPU, Gemini Nano takes about 20 seconds per card. Sus generates the deck while players join the lobby and shows each card as soon as it's ready.

## Firebase

- **Firebase AI Logic** (Gemini Developer API) with hybrid inference and structured JSON output, on device and in the cloud
- **App Check** with reCAPTCHA Enterprise, enforced for AI Logic (a debug token is used on localhost only)
- **Cloud Firestore** for live rooms, players, secret hands, votes and the deck
- **Anonymous Authentication**: every browser tab is a player, with no sign-up
- **Hosting**

### Security rules (`firestore.rules`)

- Players can read only **their own** card. The deck, the liar's identity and everyone's votes are **host-only**.
- Players can join only while the room is in the lobby, and can only rename themselves. Only the host changes scores.
- A vote must be for the current round and can't be for yourself.

## Try it

**Online:** open https://sus-study-game.web.app, click **Host a game**, and use **Try sample notes** if you don't have your own.

**Testing alone?** Each browser tab is its own player. Host in one tab, then open the join link in **3 more tabs** (or incognito windows) and join with different names.

**To see on-device AI (🔒):** use desktop Chrome 139+ with `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` set to **Enabled**. You also need a supported device: Windows/macOS/Linux with 22 GB free disk space and either a GPU with more than 4 GB VRAM, or 16 GB RAM and 4+ CPU cores. Check `chrome://on-device-internals`. On other devices, Private mode uses the cloud.

## Run locally

Requirements: Node.js 22+, a Firebase project with AI Logic (Gemini Developer API), Firestore and Anonymous Auth enabled.

```bash
cd web
npm install
cp .env.example .env.local   # then fill in your Firebase web config
npm run dev                  # http://localhost:5173
```

App Check is enforced for AI Logic, so for localhost:

1. Put any UUID in `VITE_APPCHECK_DEBUG_TOKEN` in `web/.env.local`.
2. Register it in Firebase console → App Check → Apps → your web app → ⋮ → **Manage debug tokens**.

The debug token is only read in dev builds and never ships in the production bundle.

Deploy (from the repo root):

```bash
cd web && npm run build && cd ..
firebase deploy --only hosting,firestore
```

## Project structure

```
firestore.rules              Security rules for rooms, hands, votes, deck
web/src/ai/susGenerator.ts   Hybrid models: facts -> one-lie twists, photo reading, note sampling
web/src/ai/readFile.ts       PDF (PDF.js) / image / text file reading
web/src/game/room.ts         Rooms, dealing, voting, scoring (Firestore)
web/src/screens/             Home, Host (big screen), Play (phone), Practice (solo)
web/src/components/ui.tsx    3-step notes form with file drop, paste and mode switch
```

## License

[Apache License 2.0](LICENSE)
