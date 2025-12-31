import { Storage } from "megajs";
import fs from "fs";
import path from "path";

const SESSION_FILE = path.join(process.cwd(), ".mega-session.json");

let mega = null;
let isReady = false;

async function initMega() {
  // If already initialized and ready, return existing instance
  if (mega && isReady) {
    return mega;
  }

  // Try to restore from saved session first
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      console.log("Restoring Mega session from file...");
      
      // Convert key back to Buffer if it was serialized as array
      let key = sessionData.key;
      if (Array.isArray(key)) {
        key = Buffer.from(key);
      } else if (key && key.type === 'Buffer' && Array.isArray(key.data)) {
        key = Buffer.from(key.data);
      }
      
      // Use Storage.fromJSON to properly restore session
      mega = Storage.fromJSON({
        options: {
          email: process.env.MEGA_EMAIL,
          password: process.env.MEGA_PASSWORD,
          autologin: false,
          keepalive: false,
        },
        key: key,
        sid: sessionData.sid,
        name: sessionData.name,
        user: sessionData.user,
      });

      // Wait for reload to complete - this makes storage ready

      await mega.login();
      await mega.reload(); 
      await mega.ready;
      
      isReady = true;
      
      console.log("Mega session restored successfully!");
      return mega;
    } catch (err) {
      console.log("Failed to restore session, will login fresh:", err.message);
      // Delete invalid session file
      try {
        fs.unlinkSync(SESSION_FILE);
      } catch (e) {}
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
    keepalive: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  // Wait for storage to be ready
  await mega.ready;
  isReady = true;

  // Save session data for next time
  saveSession();
  console.log("Mega login successful, session saved!");

  return mega;
}

function saveSession() {
  if (!mega) return;

  // Store key as array for proper JSON serialization
  const keyArray = mega.key ? Array.from(mega.key) : null;

  const sessionData = {
    key: keyArray,
    sid: mega.sid,
    name: mega.name,
    user: mega.user,
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
}

// Export the init function and a getter for the instance
export { initMega };
export { mega };
