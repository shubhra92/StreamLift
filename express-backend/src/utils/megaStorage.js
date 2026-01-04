import { Storage } from "megajs";
import { db, megaSessions } from "../db/index.js";
import { eq, and } from "drizzle-orm";

let mega = null;
let isReady = false;

// Get current IP info (country, IP address)
async function getCurrentIpInfo() {
  // Try ip-api.com first (free, 45 req/min limit, no API key needed)
  try {
    const response = await fetch('http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,query');
    if (response.ok) {
      const data = await response.json();
      if (data.status === 'success' && data.query && data.countryCode) {
        return {
          ip: data.query,
          country: data.countryCode,
          countryName: data.country,
          region: data.regionName,
          city: data.city,
        };
      }
    }
  } catch (err) {
    console.error("ip-api.com failed:", err.message);
  }

  // Fallback to ipwho.is (free, no rate limit advertised)
  try {
    const response = await fetch('https://ipwho.is/');
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.ip && data.country_code) {
        return {
          ip: data.ip,
          country: data.country_code,
          countryName: data.country,
          region: data.region,
          city: data.city,
        };
      }
    }
  } catch (err) {
    console.error("ipwho.is failed:", err.message);
  }

  // Last fallback: ipapi.co (has stricter rate limits)
  try {
    const response = await fetch('https://ipapi.co/json/');
    if (response.ok) {
      const data = await response.json();
      if (data.ip && data.country_code && !data.error) {
        return {
          ip: data.ip,
          country: data.country_code,
          countryName: data.country_name,
          region: data.region,
          city: data.city,
        };
      }
    }
  } catch (err) {
    console.error("ipapi.co failed:", err.message);
  }

  console.error("All IP services failed");
  return null;
}

// Get session from DB by email
async function getSessionFromDb() {
  const email = process.env.MEGA_EMAIL;
  const sessions = await db
    .select()
    .from(megaSessions)
    .where(eq(megaSessions.email, email))
    .limit(1);

  return sessions[0] || null;
}

// Get session by country
async function getSessionByCountry(country) {
  const email = process.env.MEGA_EMAIL;
  const sessions = await db
    .select()
    .from(megaSessions)
    .where(
      and(
        eq(megaSessions.email, email),
        eq(megaSessions.country, country),
        eq(megaSessions.isActive, true)
      )
    )
    .limit(1);

  return sessions[0] || null;
}

// Search sessions by country (returns all matching sessions)
async function searchSessionsByCountry(country) {
  const sessions = await db
    .select()
    .from(megaSessions)
    .where(
      and(
        eq(megaSessions.country, country),
        eq(megaSessions.isActive, true)
      )
    );

  return sessions;
}

// Get all sessions for an email
async function getAllSessionsForEmail(email) {
  const sessions = await db
    .select()
    .from(megaSessions)
    .where(eq(megaSessions.email, email || process.env.MEGA_EMAIL));

  return sessions;
}

async function saveSessionToDb(sessionData, ipInfo) {
  const email = process.env.MEGA_EMAIL;
  
  // Check if session exists for this email AND country
  const existingSession = ipInfo?.country 
    ? await getSessionByCountry(ipInfo.country)
    : await getSessionFromDb();

  if (existingSession) {
    await db
      .update(megaSessions)
      .set({
        sessionData: JSON.stringify(sessionData),
        country: ipInfo?.country || existingSession.country,
        ipAddress: ipInfo?.ip || existingSession.ipAddress,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(megaSessions.id, existingSession.id));
  } else {
    await db.insert(megaSessions).values({
      email,
      sessionData: JSON.stringify(sessionData),
      country: ipInfo?.country,
      ipAddress: ipInfo?.ip,
      isActive: true,
    });
  }
}

async function deleteSessionFromDb(sessionId) {
  if (sessionId) {
    await db
      .update(megaSessions)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(megaSessions.id, sessionId));
  } else {
    const email = process.env.MEGA_EMAIL;
    await db
      .update(megaSessions)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(megaSessions.email, email));
  }
}

async function initMega() {
  // If already initialized and ready, return existing instance
  if (mega && isReady) {
    return mega;
  }

  // Get current IP info
  const currentIpInfo = await getCurrentIpInfo();
  console.log("Current IP info:", currentIpInfo);

  // Try to find session matching current country
  let dbSession = null;
  
  if (currentIpInfo?.country) {
    dbSession = await getSessionByCountry(currentIpInfo.country);
    console.log(`Session for country ${currentIpInfo.country}:`, dbSession ? "found" : "not found");
  }
  
  // Fallback to any session for this email if no country-specific session
  if (!dbSession) {
    dbSession = await getSessionFromDb();
    console.log("Fallback session found:", dbSession ? "yes" : "no");
    
    // Check if existing session country matches current IP country
    if (dbSession && currentIpInfo?.country && dbSession.country !== currentIpInfo.country) {
      console.log(`Session country mismatch: session=${dbSession.country}, current=${currentIpInfo.country}`);
      console.log("Will create new session for current country");
      dbSession = null; // Force new login
    }
  }

  if (dbSession && dbSession.isActive && dbSession.sessionData) {
    try {
      const sessionData = JSON.parse(dbSession.sessionData);
      console.log("Restoring Mega session from database...");

      if (!sessionData.sid || !sessionData.key) {
        throw new Error("Invalid session data: missing sid or key");
      }

      mega = Storage.fromJSON({
        key: sessionData.key,
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

      await mega.reload();
      mega.status = 'ready';
      isReady = true;

      console.log("Mega session restored successfully from database!");
      return mega;
    } catch (err) {
      console.log("Failed to restore session, will login fresh:", err.message);
      await deleteSessionFromDb(dbSession.id);
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

  await mega.ready;
  isReady = true;

  // Save session with IP info
  await saveSession(currentIpInfo);
  console.log(`Mega login successful, session saved for country: ${currentIpInfo?.country || 'unknown'}`);

  return mega;
}

async function saveSession(ipInfo) {
  if (!mega) return;

  const sessionData = mega.toJSON();

  if (sessionData.options) {
    delete sessionData.options.password;
  }

  await saveSessionToDb(sessionData, ipInfo);
}

// Force create new session (useful when IP country changes)
async function createNewSession() {
  const currentIpInfo = await getCurrentIpInfo();
  console.log("Creating new session for IP:", currentIpInfo);

  // Reset current instance
  mega = null;
  isReady = false;

  // Fresh login
  console.log("Logging into Mega...");
  mega = new Storage({
    email: process.env.MEGA_EMAIL,
    password: process.env.MEGA_PASSWORD,
    autologin: true,
    keepalive: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });

  await mega.ready;
  isReady = true;

  await saveSession(currentIpInfo);
  console.log(`New Mega session created for country: ${currentIpInfo?.country || 'unknown'}`);

  return mega;
}

// Check if current session matches IP country
async function validateSessionCountry() {
  const currentIpInfo = await getCurrentIpInfo();
  const dbSession = await getSessionFromDb();

  if (!dbSession) {
    return { valid: false, reason: 'no_session', currentCountry: currentIpInfo?.country };
  }

  if (!currentIpInfo?.country) {
    return { valid: true, reason: 'ip_check_failed', sessionCountry: dbSession.country };
  }

  if (dbSession.country !== currentIpInfo.country) {
    return {
      valid: false,
      reason: 'country_mismatch',
      sessionCountry: dbSession.country,
      currentCountry: currentIpInfo.country,
    };
  }

  return {
    valid: true,
    reason: 'match',
    country: dbSession.country,
  };
}

export { 
  initMega, 
  mega,
  getCurrentIpInfo,
  getSessionByCountry,
  searchSessionsByCountry,
  getAllSessionsForEmail,
  createNewSession,
  validateSessionCountry,
};
