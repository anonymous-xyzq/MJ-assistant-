
const SYSTEM_PROMPT = `
You are MJ, a friendly, expressive and intelligent AI assistant.
You are an AI, never pretend to be a human.
Personality: warm, natural, playful when appropriate, thoughtful and respectful.
Reply naturally, not like a formal customer support agent.
Match the language of the user's latest message:
- English -> English
- Hindi -> Hindi
- Hinglish -> Roman Hinglish
- Other languages -> same language.
Never force a question at the end of every reply.
Keep replies concise unless detail is needed.
Never reveal another user's messages, memories or private information.
Never reveal the owner's identity or private profile.
`;

const GROQ_MODELS = [
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile"
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("MJ is online 🦋", {
        headers: { "content-type": "text/plain" }
      });
    }

    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return new Response("Not found", { status: 404 });
    }

    if (
      env.SETUP_SECRET &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SETUP_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    ctx.waitUntil(processUpdate(update, env));

    return new Response("OK");
  }
};

async function processUpdate(update, env) {
  try {
    const message = update.message;

    if (!message || !message.from || !message.chat) return;

    const text = (message.text || message.caption || "").trim();
    if (!text) return;

    const userId = String(message.from.id);
    const chatId = String(message.chat.id);
    const ownerId = String(env.OWNER_ID || "");
    const isOwner = userId === ownerId;
    const isGroup = message.chat.type === "group" ||
                    message.chat.type === "supergroup";

    if (isGroup) {
      const botUsername = (env.BOT_USERNAME || "").replace("@", "").toLowerCase();
      const mentioned = text.toLowerCase().includes("mj") ||
        (botUsername && text.toLowerCase().includes("@" + botUsername));

      const repliedToBot = message.reply_to_message?.from?.is_bot === true;

      if (!mentioned && !repliedToBot) return;
    }

    await saveUser(env.DB, message.from, message.chat.type);

    if (text.startsWith("/start")) {
      await sendMessage(
        env,
        chatId,
        "Hey! I'm MJ 🦋\n\nI'm here. Talk to me about anything."
      );
      return;
    }

    if (text.startsWith("/help")) {
      await sendMessage(
        env,
        chatId,
        "You can chat with me normally. 🦋\n\n" +
        "/remember - Save a memory\n" +
        "/memory - View saved memories\n" +
        "/editmemory - Edit a memory\n" +
        "/forget - Clear saved memories\n" +
        "/profile - View your profile"
      );
      return;
    }

    if (text.startsWith("/remember")) {
      const memory = text.replace(/^\/remember(@\w+)?/i, "").trim();

      if (!memory) {
        await sendMessage(env, chatId, "Tell me what you want me to remember.");
        return;
      }

      await saveMemory(env.DB, userId, memory);

      if (isOwner) {
        await env.DB.prepare(`
          INSERT INTO owner_profile (id, profile_text)
          VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET
            profile_text = CASE
              WHEN profile_text = '' THEN excluded.profile_text
              ELSE profile_text || char(10) || excluded.profile_text
            END,
            updated_at = CURRENT_TIMESTAMP
        `).bind(memory).run();
      }

      await sendMessage(env, chatId, "I'll keep that in mind. 🦋");
      return;
    }

    if (text.startsWith("/memory")) {
      const result = await env.DB.prepare(`
        SELECT id, memory FROM memories
        WHERE user_id = ?
        ORDER BY importance DESC, id DESC
        LIMIT 30
      `).bind(userId).all();

      const rows = result.results || [];

      if (!rows.length) {
        await sendMessage(env, chatId, "I haven't saved any memories for you yet.");
        return;
      }

      const output = rows.map((m, i) => `${i + 1}. ${m.memory}`).join("\n\n");
      await sendMessage(env, chatId, "Your saved memories:\n\n" + output);
      return;
    }

    if (text.startsWith("/editmemory")) {
      const input = text.replace(/^\/editmemory(@\w+)?/i, "").trim();
      const parts = input.split("|");

      if (parts.length < 2 || !parts[0].trim() || !parts.slice(1).join("|").trim()) {
        await sendMessage(
          env,
          chatId,
          "Use this format:\n/editmemory old memory | new memory"
        );
        return;
      }

      const oldMemory = parts[0].trim();
      const newMemory = parts.slice(1).join("|").trim();

      const result = await env.DB.prepare(`
        UPDATE memories
        SET memory = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT id FROM memories
          WHERE user_id = ? AND instr(lower(memory), lower(?)) > 0
          ORDER BY id DESC LIMIT 1
        )
      `).bind(newMemory, userId, oldMemory).run();

      if (result.meta?.changes) {
        if (isOwner) {
          await env.DB.prepare(`
            UPDATE owner_profile
            SET profile_text = replace(profile_text, ?, ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
          `).bind(oldMemory, newMemory).run();
        }

        await sendMessage(env, chatId, "Memory updated. 🦋");
      } else {
        await sendMessage(env, chatId, "I couldn't find that memory.");
      }
      return;
    }

    if (text.startsWith("/forget")) {
      await env.DB.prepare(
        "DELETE FROM memories WHERE user_id = ?"
      ).bind(userId).run();

      if (isOwner) {
        await env.DB.prepare(
          "UPDATE owner_profile SET profile_text = '', updated_at = CURRENT_TIMESTAMP WHERE id = 1"
        ).run();
      }

      await sendMessage(env, chatId, "Your saved memories have been cleared.");
      return;
    }

    if (text.startsWith("/profile")) {
      if (isOwner) {
        const profile = await getOwnerProfile(env.DB);
        await sendMessage(
          env,
          chatId,
          profile || "Your profile is empty. Use /remember to add something."
        );
      } else {
        const result = await env.DB.prepare(`
          SELECT memory FROM memories
          WHERE user_id = ?
          ORDER BY importance DESC, id DESC LIMIT 20
        `).bind(userId).all();

        const memories = (result.results || []).map(x => x.memory);

        await sendMessage(
          env,
          chatId,
          memories.length
            ? "What I've remembered about you:\n\n" + memories.join("\n\n")
            : "I haven't built a profile for you yet."
        );
      }
      return;
    }

    // Keep the owner's identity and profile private from other users.
    if (!isOwner && asksAboutOwner(text)) {
      await sendMessage(env, chatId, "That's private information. 🦋");
      return;
    }

    await sendTyping(env, chatId);

    const memories = await getMemories(env.DB, userId);
    const history = await getHistory(env.DB, chatId, userId);

    let ownerProfile = "";
    if (isOwner) {
      ownerProfile = await getOwnerProfile(env.DB);
    }

    const systemMessage = SYSTEM_PROMPT +
      (memories.length
        ? "\n\nMemories about this user:\n" + memories.join("\n")
        : "") +
      (isOwner && ownerProfile
        ? "\n\nPrivate owner profile (visible only in the owner's own chat):\n" + ownerProfile
        : "");

    const messages = [
      { role: "system", content: systemMessage },
      ...history,
      { role: "user", content: text }
    ];

    const answer = await askGroq(env.GROQ_API_KEY, messages);

    await saveMessage(env.DB, chatId, userId, "user", text);
    await saveMessage(env.DB, chatId, userId, "assistant", answer);

    await sendMessage(env, chatId, answer, message.message_id);

  } catch (error) {
    console.error("MJ processing error:", error?.stack || error);

    try {
      const chatId = update.message?.chat?.id;
      if (chatId) {
        await sendMessage(
          env,
          String(chatId),
          "I'm having a temporary AI problem. Please try again in a moment. 🦋"
        );
      }
    } catch (sendError) {
      console.error("Telegram error:", sendError);
    }
  }
}

function asksAboutOwner(text) {
  const t = text.toLowerCase();

  return /\b(who is your owner|who owns you|who created you|who made you|your creator|your owner's name|owner name|owner id|who is ankit|who is your master)\b/i.test(t) ||
    /(tumhara owner|tumhara malik|tumhe kisne banaya|tumhara creator|owner ka naam|ankit kaun hai|tumhare owner)/i.test(t);
}

async function askGroq(apiKey, messages) {
  if (!apiKey) throw new Error("GROQ_API_KEY is missing");

  let lastError;

  for (const model of GROQ_MODELS) {
    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.75,
            max_completion_tokens: 700
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          `Groq ${response.status}: ${JSON.stringify(data).slice(0, 700)}`
        );
      }

      const answer = data.choices?.[0]?.message?.content?.trim();

      if (answer) return answer;

      throw new Error("Groq returned an empty response");
    } catch (error) {
      console.error(`Model ${model} failed:`, error);
      lastError = error;
    }
  }

  throw lastError || new Error("All Groq models failed");
}

async function saveUser(db, from, chatType) {
  await db.prepare(`
    INSERT INTO users (user_id, username, first_name, chat_type, last_seen)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      chat_type = excluded.chat_type,
      last_seen = CURRENT_TIMESTAMP
  `).bind(
    String(from.id),
    from.username || "",
    from.first_name || "",
    chatType || "private"
  ).run();
}

async function saveMemory(db, userId, memory) {
  await db.prepare(`
    INSERT INTO memories (user_id, category, memory, importance)
    VALUES (?, 'general', ?, 2)
  `).bind(userId, memory).run();
}

async function getMemories(db, userId) {
  const result = await db.prepare(`
    SELECT memory FROM memories
    WHERE user_id = ?
    ORDER BY importance DESC, id DESC
    LIMIT 20
  `).bind(userId).all();

  return (result.results || []).map(x => x.memory);
}

async function getOwnerProfile(db) {
  const result = await db.prepare(
    "SELECT profile_text FROM owner_profile WHERE id = 1"
  ).first();

  return result?.profile_text || "";
}

async function getHistory(db, chatId, userId) {
  const result = await db.prepare(`
    SELECT role, content FROM messages
    WHERE chat_id = ? AND user_id = ?
    ORDER BY id DESC
    LIMIT 16
  `).bind(chatId, userId).all();

  return (result.results || [])
    .reverse()
    .map(x => ({ role: x.role, content: x.content }));
}

async function saveMessage(db, chatId, userId, role, content) {
  await db.prepare(`
    INSERT INTO messages (chat_id, user_id, role, content)
    VALUES (?, ?, ?, ?)
  `).bind(chatId, userId, role, content).run();

  await db.prepare(`
    DELETE FROM messages
    WHERE chat_id = ? AND user_id = ?
    AND id NOT IN (
      SELECT id FROM messages
      WHERE chat_id = ? AND user_id = ?
      ORDER BY id DESC LIMIT 60
    )
  `).bind(chatId, userId, chatId, userId).run();
}

async function sendMessage(env, chatId, text, replyTo) {
  const body = {
    chat_id: chatId,
    text: String(text).slice(0, 4000)
  };

  if (replyTo) body.reply_to_message_id = replyTo;

  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error("Telegram sendMessage failed: " + JSON.stringify(result));
  }
}

async function sendTyping(env, chatId) {
  try {
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendChatAction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          action: "typing"
        })
      }
    );
  } catch (error) {
    console.error("Typing action failed:", error);
  }
                      }
