import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const app = express();
const PORT = 3000;

app.use(express.json());

// Server-side lazy initialization of Gemini AI
let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// AI DJ Assistant Endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const ai = getAI();

    const systemInstruction = `Du bist der state-of-the-art AI DJ Assistant in der "Airdox DJ Library & Controller Hub" Software.
Du unterstützt den DJ bei Library Management, harmonischem Track-Matching (Camelot Wheel / Rekordbox Transition Links), Set-Planung und Hardware-Steuerung (Pioneer DDJ-FLX4 / DDJ-1000).

WICHTIGSTE REGEL (STRIKT UND UNVERLETZLICH):
Originaldateien dürfen NIEMALS verändert werden. Du arbeitest zu 100% nicht-destruktiv auf einer Metadaten- und Linking-Ebene mit reinen Leserechten bezüglich der Audio-Quelldateien.

Du kannst sowohl direkt auf Deutsch antworten als auch strukturierte Befehle ausführen, die die Library im Frontend anpassen.
Wenn der Benutzer eine Aktion anfordert (z.B. filtern, Tracks verknüpfen, passende Tracks finden, Track auf Deck 1 oder 2 laden, Playlist erstellen, Tags zuweisen), generiere eine entsprechende Aktion im JSON-Block am Ende deiner Antwort oder erkläre es verständlich.

Mögliche Aktionen im Format:
\`\`\`action
{
  "actionType": "filter_library" | "link_tracks" | "find_harmonic_matches" | "load_to_deck" | "set_filter_linked_only" | "create_smart_setlist",
  "payload": { ... }
}
\`\`\`

Beispiele:
- Wenn der User sagt "Zeige mir alle Tracks mit Verknüpfungen" -> actionType: "set_filter_linked_only", payload: { "linkedOnly": true }
- Wenn der User sagt "Verknüpfe Track 1 und 3" -> actionType: "link_tracks", payload: { "sourceId": "track-1", "targetId": "track-3", "mixType": "smooth_blend", "notes": "Harmonischer Übergang im Outro" }
- Wenn der User nach passenden Tracks fragt -> erkläre die Camelot-Harmonie (z.B. 8A -> 8A, 7A, 9A, 8B) und biete konkrete Empfehlungen.

Kontext der aktuellen Library:
${JSON.stringify(context || {}, null, 2)}
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: message,
      config: {
        systemInstruction,
        temperature: 0.7,
      },
    });

    const replyText = response.text || "Ich konnte keine passende Antwort generieren.";

    // Parse potential action block
    let action = null;
    const actionMatch = replyText.match(/```action\s*([\s\S]*?)\s*```/);
    if (actionMatch && actionMatch[1]) {
      try {
        action = JSON.parse(actionMatch[1]);
      } catch {
        // ignore JSON parse error
      }
    }

    // Cleaned message without raw code block if action was extracted
    const cleanText = replyText.replace(/```action[\s\S]*?```/, "").trim();

    return res.json({
      text: cleanText || replyText,
      action,
    });
  } catch (error: any) {
    console.error("Gemini Chat Error:", error);
    return res.status(500).json({
      error: error.message || "Failed to communicate with AI Assistant.",
      fallbackText: "Der AI DJ Assistant konnte derzeit nicht kontaktiert werden. Bitte prüfe deine API-Einstellungen.",
    });
  }
});

// Git status and push management API
app.get("/api/git/status", async (_req, res) => {
  try {
    const { stdout: statusOut } = await execAsync("git status --porcelain");
    const { stdout: branchOut } = await execAsync("git branch --show-current").catch(() => ({ stdout: "main\n" }));
    const { stdout: logOut } = await execAsync("git log -1 --oneline").catch(() => ({ stdout: "No commits yet\n" }));
    const { stdout: remoteOut } = await execAsync("git remote -v").catch(() => ({ stdout: "" }));

    res.json({
      branch: branchOut.trim() || "main",
      dirty: statusOut.trim().length > 0,
      changedFiles: statusOut.trim().split("\n").filter(Boolean),
      lastCommit: logOut.trim(),
      remote: remoteOut.trim(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/git/push", async (_req, res) => {
  try {
    // Stage, commit, and push
    await execAsync("git add -A");
    const commitMsg = `feat: Update Airdox DJ Library & Controller Hub - ${new Date().toISOString().split("T")[0]}`;
    await execAsync(`git commit -m "${commitMsg}"`).catch(() => {
      // might be clean already
    });
    
    // Attempt push to origin main
    const { stdout, stderr } = await execAsync("git push -u origin main --force");
    res.json({
      success: true,
      message: "Successfully pushed to GitHub repository!",
      output: stdout || stderr,
    });
  } catch (error: any) {
    console.error("Git push error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Git push failed",
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
