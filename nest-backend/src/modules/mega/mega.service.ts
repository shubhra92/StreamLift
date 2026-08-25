import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Storage } from 'megajs';
import { db, megaSessions } from '../../db/index.js';
import { eq, and } from 'drizzle-orm';

@Injectable()
export class MegaService implements OnModuleInit {
  private readonly logger = new Logger(MegaService.name);
  private mega: InstanceType<typeof Storage> | null = null;
  private ready = false;
  private reinitializing = false;

  async onModuleInit() {
    try {
      await this.init();
      this.logger.log('Connected to MEGA ✅');
    } catch (err: any) {
      this.logger.error('MEGA connection failed: ' + err.message);
      // Still mark ready so non-MEGA routes work
      this.ready = true;
    }
  }

  async getInstance(): Promise<InstanceType<typeof Storage>> {
    if (this.mega && this.ready) return this.mega;
    return this.init();
  }

  /**
   * Called when the MEGA session becomes invalid (ESID -15, etc.).
   * Invalidates the cache so the next getInstance() triggers a fresh login.
   */
  private async handleSessionError(err: Error) {
    this.logger.error('MEGA session error: ' + err.message);
    this.mega = null;
    this.ready = false;

    // Deactivate the stale session in DB so init() doesn't try to restore it
    try {
      await this.deleteSessionFromDb();
      this.logger.log('Stale MEGA session deactivated in DB');
    } catch (e: any) {
      this.logger.error('Failed to deactivate stale session: ' + e.message);
    }
  }

  /**
   * Attach an error handler to the MEGA Storage instance so that
   * an expired session (ESID -15) doesn't crash the Node process.
   */
  private attachErrorHandler(mega: InstanceType<typeof Storage>) {
    (mega as any).on?.('error', (err: Error) => {
      this.logger.error('MEGA Storage error event: ' + err.message);
      if (!this.reinitializing) {
        this.reinitializing = true;
        this.handleSessionError(err).finally(() => {
          this.reinitializing = false;
        });
      }
    });
  }

  // ── IP helpers ──────────────────────────────────────────────────────────────

  private async getCurrentIpInfo(): Promise<{
    ip: string;
    country: string;
  } | null> {
    const services = [
      async () => {
        const r = await fetch('http://ip-api.com/json/?fields=status,country,countryCode,query');
        if (!r.ok) return null;
        const d = await r.json();
        if (d.status !== 'success') return null;
        return { ip: d.query as string, country: d.countryCode as string };
      },
      async () => {
        const r = await fetch('https://ipwho.is/');
        if (!r.ok) return null;
        const d = await r.json();
        if (!d.success) return null;
        return { ip: d.ip as string, country: d.country_code as string };
      },
    ];

    for (const svc of services) {
      try {
        const result = await svc();
        if (result) return result;
      } catch (_) {}
    }
    return null;
  }

  // ── DB helpers ───────────────────────────────────────────────────────────────

  private async getSessionByCountry(country: string) {
    const email = process.env.MEGA_EMAIL!;
    const rows = await db
      .select()
      .from(megaSessions)
      .where(
        and(
          eq(megaSessions.email, email),
          eq(megaSessions.country, country),
          eq(megaSessions.isActive, true),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async getSessionFromDb() {
    const email = process.env.MEGA_EMAIL!;
    const rows = await db
      .select()
      .from(megaSessions)
      .where(eq(megaSessions.email, email))
      .limit(1);
    return rows[0] ?? null;
  }

  private async saveSessionToDb(
    sessionData: Record<string, any>,
    ipInfo: { ip: string; country: string } | null,
  ) {
    const email = process.env.MEGA_EMAIL!;
    const existing = ipInfo?.country
      ? await this.getSessionByCountry(ipInfo.country)
      : await this.getSessionFromDb();

    if (existing) {
      await db
        .update(megaSessions)
        .set({
          sessionData: JSON.stringify(sessionData),
          country: ipInfo?.country ?? existing.country,
          ipAddress: ipInfo?.ip ?? existing.ipAddress,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(megaSessions.id, existing.id));
    } else {
      await db.insert(megaSessions).values({
        email,
        sessionData: JSON.stringify(sessionData),
        country: ipInfo?.country ?? null,
        ipAddress: ipInfo?.ip ?? null,
        isActive: true,
      });
    }
  }

  private async deleteSessionFromDb(sessionId?: string) {
    const email = process.env.MEGA_EMAIL!;
    if (sessionId) {
      await db
        .update(megaSessions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(megaSessions.id, sessionId));
    } else {
      await db
        .update(megaSessions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(megaSessions.email, email));
    }
  }

  // ── Init / login ─────────────────────────────────────────────────────────────

  async init(): Promise<InstanceType<typeof Storage>> {
    if (this.mega && this.ready) return this.mega;

    const ipInfo = await this.getCurrentIpInfo();
    this.logger.log(`Current IP info: ${JSON.stringify(ipInfo)}`);

    let dbSession = null;
    if (ipInfo?.country) {
      dbSession = await this.getSessionByCountry(ipInfo.country);
    }
    if (!dbSession) {
      dbSession = await this.getSessionFromDb();
      if (dbSession && ipInfo?.country && dbSession.country !== ipInfo.country) {
        this.logger.warn('Session country mismatch — forcing fresh login');
        dbSession = null;
      }
    }

    if (dbSession?.isActive && dbSession.sessionData) {
      try {
        const sessionData = JSON.parse(dbSession.sessionData);
        if (!sessionData.sid || !sessionData.key) throw new Error('Invalid session data');

        this.logger.log('Restoring MEGA session from DB...');
        this.mega = Storage.fromJSON({
          key: sessionData.key,
          sid: sessionData.sid,
          name: sessionData.name,
          user: sessionData.user,
          options: {
            email: process.env.MEGA_EMAIL!,
            password: process.env.MEGA_PASSWORD!,
            keepalive: true,
            autoload: false,
            autologin: false,
          },
        }) as InstanceType<typeof Storage>;

        await (this.mega as any).reload();
        this.ready = true;
        this.attachErrorHandler(this.mega);
        this.logger.log('MEGA session restored ✅');
        return this.mega;
      } catch (err: any) {
        this.logger.warn('Session restore failed, fresh login: ' + err.message);
        await this.deleteSessionFromDb(dbSession.id);
        this.mega = null;
        this.ready = false;
      }
    }

    this.logger.log('Logging into MEGA fresh...');
    this.mega = new Storage({
      email: process.env.MEGA_EMAIL!,
      password: process.env.MEGA_PASSWORD!,
      autologin: true,
      keepalive: true,
    }) as InstanceType<typeof Storage>;

    await (this.mega as any).ready;
    this.ready = true;
    this.attachErrorHandler(this.mega);

    const sessionData = (this.mega as any).toJSON();
    if (sessionData?.options) delete sessionData.options.password;
    await this.saveSessionToDb(sessionData, ipInfo);
    this.logger.log(`MEGA login ✅ country: ${ipInfo?.country ?? 'unknown'}`);

    return this.mega;
  }

  async getOrCreateFolder(parentNode: any, folderName: string): Promise<any> {
    const children = Object.values(parentNode.children ?? {}) as any[];
    const existing = children.find((n) => n.directory && n.name === folderName);
    if (existing) return existing;
    return parentNode.mkdir(folderName);
  }

  isServerReady(): boolean {
    return this.ready;
  }
}
