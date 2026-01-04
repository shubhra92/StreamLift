import { Storage } from "megajs";
import { db, megaSessions } from "../db/index.js";
import { eq } from "drizzle-orm";

let mega = null;
let isReady = false;

async function getSessionFromDb() {
  const email = process.env.MEGA_EMAIL;
  const sessions = await db
    .select()
    .from(megaSessions)
    .where(eq(megaSessions.email, email))
    .limit(1);

  return sessions[0] || null;
}

async function saveSessionToDb(sessionData) {
  const email = process.env.MEGA_EMAIL;
  const existingSession = await getSessionFromDb();

  if (existingSession) {
    await db
      .update(megaSessions)
      .set({
        sessionData: JSON.stringify(sessionData),
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(megaSessions.email, email));
  } else {
    await db.insert(megaSessions).values({
      email,
      sessionData: JSON.stringify(sessionData),
      isActive: true,
    });
  }
}

async function deleteSessionFromDb() {
  const email = process.env.MEGA_EMAIL;
  await db
    .update(megaSessions)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(megaSessions.email, email));
}

async function initMega() {
  // If already initialized and ready, return existing instance
  if (mega && isReady) {
    return mega;
  }

  // Try to restore from saved session in DB
  const dbSession = await getSessionFromDb();

  console.log("DB Session found:", dbSession ? "yes" : "no");

  if (dbSession && dbSession.isActive && dbSession.sessionData) {
    try {
      const sessionData = JSON.parse(dbSession.sessionData);
      console.log("Restoring Mega session from database...");

      if (!sessionData.sid || !sessionData.key) {
        throw new Error("Invalid session data: missing sid or key");
      }

      // Use Storage.fromJSON - it expects the same format as toJSON() output
      // key should be base64 string, not array
      mega = Storage.fromJSON({
        key: sessionData.key,  // base64 string
        sid: sessionData.sid,
        name: sessionData.name,
        user: sessionData.user,
        options: {
          email: process.env.MEGA_EMAIL,
          keepalive: true,
          autoload: false,
          autologin: false,
        },
      });

      // reload() fetches file tree using existing sid
      await mega.reload();

      // Manually set status to 'ready' since reload() doesn't do it
      // (only login() sets status, but we're restoring session)
      mega.status = 'ready';

      isReady = true;

      console.log("Mega session restored successfully from database!");
      return mega;
    } catch (err) {
      console.log("Failed to restore session, will login fresh");
      await deleteSessionFromDb();
      mega = null;
      isReady = false;
    }
  }

  // Fresh login
  console.log("Logging into Mega...");
  mega = new Storage({
    email: process.env.MEGA_EMAIL,
    password: process.env.MEGA_PASSWORD,
    autologin: true,
    keepalive: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });

  // Wait for storage to be ready
  await mega.ready;
  isReady = true;

  // Save session using toJSON() format
  await saveSession();
  console.log("Mega login successful, session saved to database!");

  return mega;
}

async function saveSession() {
  if (!mega) return;

  // Use mega.toJSON() which returns the correct format:
  // { key: base64string, sid, name, user, options }
  const sessionData = mega.toJSON();

  // Don't save password in options
  if (sessionData.options) {
    delete sessionData.options.password;
  }

  await saveSessionToDb(sessionData);
}

// Export the init function and a getter for the instance
export { initMega };
export { mega };
